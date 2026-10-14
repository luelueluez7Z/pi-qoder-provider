import type { Api, Model, OAuthCredentials, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
  getQoderBaseUrl,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  toQoderCNFriendlyModel,
  toQoderGlobalFriendlyModel,
} from "./cosy.js";
import {
  formatQoderPriceFactor,
  getCachedModels,
  isCacheStale,
  qoderThinkingLevelMap,
  staticCnModels,
  staticModels,
  updateQoderModelsCache,
} from "./models.js";
import {
  autoLoginQoderFromEnvironment,
  cancelQoderEnvironmentLogin,
  loginQoder,
  loginQoderCN,
  type QoderCredentials,
  refreshQoderToken,
  refreshQoderTokenCN,
  resolveQoderIdentity,
  waitForQoderEnvironmentLogin,
} from "./oauth.js";
import { streamQoder } from "./stream.js";
import { fetchQoderUsage, fetchQoderUsageCN } from "./usage.js";

// pi supports a `fetchUsage` hook on the oauth config at runtime, but it is not
// part of the published ProviderConfig type. Declare it locally.
type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

function modelsForProvider(mode: string, providerID: string): Model<Api>[] {
  const cached = getCachedModels(mode);
  const modelsToUse = cached.length > 0 ? cached : isQoderCNMode(mode) ? staticCnModels : staticModels;

  return modelsToUse.map((m) => {
    const model = isQoderCNMode(mode) ? toQoderCNFriendlyModel(m) : toQoderGlobalFriendlyModel(m);
    // Append the relative credit multiplier (price_factor) to the display name
    // so the /model selector's "Model Name:" line shows it, e.g.
    // "DeepSeek V4 Pro · ×0.8". The multiplier is live-refreshed via
    // refreshModels whenever /model opens.
    const name = `${model.name}${formatQoderPriceFactor(m.priceFactor)}`;
    const out: Record<string, unknown> = {
      ...model,
      name,
      provider: providerID,
      baseUrl: getQoderBaseUrl(mode),
    };
    // Forward qoder's effort surface (from thinking_config.enabled.efforts) as
    // a pi thinkingLevelMap so the /model selector shows exactly the levels
    // qoder supports (e.g. off / high / max) instead of a generic ladder.
    if (model.thinking) out.thinkingLevelMap = qoderThinkingLevelMap(model);
    return out as unknown as Model<Api>;
  });
}

/**
 * Live model catalog refresh invoked by pi's /model (and --list-models). When
 * network access + an OAuth credential are available, re-pull /model/list so
 * the displayed credit multipliers (price_factor) are never stale; otherwise
 * fall back to the current cache. Always returns the latest known model list.
 */
async function refreshQoderModels(
  mode: string,
  providerID: string,
  context: RefreshModelsContext,
): Promise<NonNullable<ProviderConfig["models"]>> {
  const accessToken = context.credential?.type === "oauth" ? context.credential.access : undefined;
  if (context.allowNetwork && accessToken) {
    try {
      const identity = await resolveQoderIdentity(accessToken, providerID, mode);
      if (identity?.userID) {
        await updateQoderModelsCache(
          accessToken,
          identity.userID,
          identity.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
          identity.email || getQoderUserEmailFallback(mode),
          mode,
        );
      }
    } catch {
      // Best-effort: fall back to the existing cache / static models.
    }
  }
  return modelsForProvider(mode, providerID) as NonNullable<ProviderConfig["models"]>;
}

function oauthDisplayName(providerID: string, mode: string): string {
  // Always distinguish by providerID. When getQoderMode() is "cn", both
  // `qoder` and `qoder-cn` would otherwise show as "Qoder CN (PAT)" in /provider.
  if (providerID === "qoder-cn") return "Qoder CN (PAT)";
  if (isQoderCNMode(mode)) return "Qoder (CN mode / PAT)";
  return "Qoder (Browser OAuth / PAT)";
}

function createQoderOAuth(providerID: string, mode: string): OAuthConfigWithUsage {
  return {
    name: oauthDisplayName(providerID, mode),
    login: (callbacks) => {
      cancelQoderEnvironmentLogin(providerID);
      return (isQoderCNMode(mode) ? loginQoderCN : loginQoder)(callbacks);
    },
    refreshToken: isQoderCNMode(mode) ? refreshQoderTokenCN : refreshQoderToken,
    getApiKey: (cred: OAuthCredentials) => cred.access,
    modifyModels: (models: Model<Api>[], _cred: OAuthCredentials) => {
      const nonQoder = models.filter((m: Model<Api>) => m.provider !== providerID);
      return [...nonQoder, ...modelsForProvider(mode, providerID)];
    },
    fetchUsage: isQoderCNMode(mode) ? fetchQoderUsageCN : fetchQoderUsage,
  };
}

// ModelRegistry requires apiKey or oauth whenever models are present, including
// re-registration after a cache refresh. Always include oauth so session_start
// can publish an updated model list without failing validation.
function modelConfigForProvider(
  mode: string,
  providerID: string,
): Pick<ProviderConfig, "api" | "baseUrl" | "models" | "oauth" | "refreshModels" | "streamSimple"> {
  return {
    baseUrl: getQoderBaseUrl(mode),
    api: "qoder-api" as Api,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: createQoderOAuth(providerID, mode) as ProviderConfig["oauth"],
    refreshModels: (context: RefreshModelsContext) => refreshQoderModels(mode, providerID, context),
    streamSimple: streamQoder,
  };
}

function registerQoderProvider(pi: ExtensionAPI, providerID: string, mode: string): void {
  pi.registerProvider(providerID, modelConfigForProvider(mode, providerID));
}

type QoderModelRegistry = {
  getApiKeyForProvider(providerID: string): Promise<string | undefined>;
  registerProvider(providerID: string, config: ProviderConfig): void;
};

const backgroundModelRefreshes = new Map<string, Promise<void>>();

function refreshModelsInBackground(providerID: string, mode: string, registry: QoderModelRegistry): void {
  if (backgroundModelRefreshes.has(providerID)) return;

  const refresh = (async () => {
    let loginCredentials: QoderCredentials | undefined;
    try {
      loginCredentials = await waitForQoderEnvironmentLogin(providerID);
    } catch {
      // A failed PAT exchange should not block use of an existing Pi credential.
    }

    const accessToken = loginCredentials?.access || (await registry.getApiKeyForProvider(providerID));
    if (!accessToken) return;

    const credentials = loginCredentials?.userID
      ? loginCredentials
      : await resolveQoderIdentity(accessToken, providerID, mode);
    if (!credentials?.userID) return;

    await updateQoderModelsCache(
      accessToken,
      credentials.userID,
      credentials.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User"),
      credentials.email || getQoderUserEmailFallback(mode),
      mode,
    );
    registry.registerProvider(providerID, modelConfigForProvider(mode, providerID));
  })()
    .catch(() => {
      // Best-effort background refresh; retain the registered cache/static catalog.
    })
    .finally(() => {
      backgroundModelRefreshes.delete(providerID);
    });

  backgroundModelRefreshes.set(providerID, refresh);
}

export default async function (pi: ExtensionAPI) {
  const providers = [
    ["qoder", getQoderMode()],
    ["qoder-cn", "cn"],
  ] as const;
  let activeModelRegistry: QoderModelRegistry | undefined;
  const refreshAfterLogin = new Set<string>();

  for (const [providerID, mode] of providers) {
    void autoLoginQoderFromEnvironment(providerID, mode)
      .then((credentials) => {
        if (!credentials) return;
        if (activeModelRegistry) refreshModelsInBackground(providerID, mode, activeModelRegistry);
        else refreshAfterLogin.add(providerID);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
      });
  }

  // The credential store reloads auth.json by file revision on each request. Wait
  // here (after startup, before Pi resolves credentials) so an immediate first
  // Qoder request cannot race the asynchronous PAT exchange/write.
  pi.on("before_agent_start", async (_event, ctx) => {
    const providerID = ctx.model?.provider;
    if (providerID !== "qoder" && providerID !== "qoder-cn") return;
    try {
      await waitForQoderEnvironmentLogin(providerID);
    } catch {
      // Preserve normal Pi auth behavior if the automatic login fails.
    }
  });

  // Cache/network work is deliberately detached: Pi waits for this handler, so
  // it must only schedule stale-cache refreshes, never await them.
  pi.on("session_start", (_event, ctx) => {
    activeModelRegistry = ctx.modelRegistry;
    for (const [providerID, mode] of providers) {
      const refreshAfterAutoLogin = refreshAfterLogin.delete(providerID);
      if (refreshAfterAutoLogin || isCacheStale(mode)) {
        refreshModelsInBackground(providerID, mode, ctx.modelRegistry);
      }
    }
  });

  registerQoderProvider(pi, "qoder", getQoderMode());
  registerQoderProvider(pi, "qoder-cn", "cn");
}
