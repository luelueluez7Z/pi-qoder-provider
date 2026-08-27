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
  loginQoder,
  loginQoderCN,
  refreshQoderToken,
  refreshQoderTokenCN,
  resolveQoderIdentity,
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
    login: isQoderCNMode(mode) ? loginQoderCN : loginQoder,
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
): Pick<ProviderConfig, "api" | "baseUrl" | "models" | "oauth" | "refreshModels"> {
  return {
    baseUrl: getQoderBaseUrl(mode),
    api: "qoder-api" as Api,
    models: modelsForProvider(mode, providerID) as unknown as ProviderConfig["models"],
    oauth: createQoderOAuth(providerID, mode) as ProviderConfig["oauth"],
    refreshModels: (context: RefreshModelsContext) => refreshQoderModels(mode, providerID, context),
  };
}

function registerQoderProvider(pi: ExtensionAPI, providerID: string, mode: string): void {
  pi.registerProvider(providerID, {
    ...modelConfigForProvider(mode, providerID),
    streamSimple: streamQoder,
  });
}

export default async function (pi: ExtensionAPI) {
  for (const [providerID, mode] of [
    ["qoder", getQoderMode()],
    ["qoder-cn", "cn"],
  ] as const) {
    try {
      await autoLoginQoderFromEnvironment(providerID, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-provider-qoder] Automatic login failed for ${providerID}: ${message}`);
    }
  }

  // Refresh the models cache once per session at startup if it is missing or
  // stale (>1h old), rather than on every message in the stream hot path.
  pi.on("session_start", async (_event, ctx) => {
    for (const [providerID, mode] of [
      ["qoder", getQoderMode()],
      ["qoder-cn", "cn"],
    ] as const) {
      try {
        const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerID);
        if (!accessToken || !isCacheStale(mode)) continue;
        // Prefer auth.json, else /userinfo(access). Never use a placeholder userID.
        const creds = await resolveQoderIdentity(accessToken, providerID, mode);
        if (!creds?.userID) continue;
        const userID = creds.userID;
        const name = creds.name || (isQoderCNMode(mode) ? "Qoder CN User" : "Qoder User");
        const email = creds.email || getQoderUserEmailFallback(mode);
        await updateQoderModelsCache(accessToken, userID, name, email, mode);
        // The provider was registered before session_start from the previous cache.
        // Publish the refreshed snapshot immediately so the current model picker
        // sees newly released models without restarting.
        ctx.modelRegistry.registerProvider(providerID, modelConfigForProvider(mode, providerID));
      } catch {
        // Best-effort: fall back to the existing cache / static models.
      }
    }
  });

  registerQoderProvider(pi, "qoder", getQoderMode());
  registerQoderProvider(pi, "qoder-cn", "cn");
}
