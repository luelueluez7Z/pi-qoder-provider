import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
  getMachineId,
  getQoderCNPat,
  getQoderMode,
  getQoderRefreshURL,
  getQoderUserEmailFallback,
  isQoderCNMode,
} from "./cosy.js";
import { withQoderHttpTimeout } from "./http.js";
import { interactiveLogin } from "./login.js";
import { updateQoderModelsCache } from "./models.js";
import {
  credentialsFromJobTokens,
  credentialsFromPat,
  decodePatRefresh,
  fetchUserInfo,
  isPatRefresh,
  refreshJobToken,
} from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

/** Identity-only fields kept in the process-local cache (never access/refresh/PAT). */
export interface QoderIdentity {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

/**
 * Process-local identity cache.
 * Key: providerID + SHA-256(accessToken). Value: identity fields only.
 * Never stores access/refresh.
 */
const identityMemoryCache = new Map<string, QoderIdentity>();

function hashAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function identityCacheKey(providerID: string, accessToken: string): string {
  return `${providerID}\0${hashAccessToken(accessToken)}`;
}

function clearProviderIdentityCache(providerID: string): void {
  const prefix = `${providerID}\0`;
  for (const key of [...identityMemoryCache.keys()]) {
    if (key.startsWith(prefix)) identityMemoryCache.delete(key);
  }
}

function toQoderIdentity(creds: Pick<QoderCredentials, "userID" | "email" | "name" | "machineID">): QoderIdentity {
  return {
    userID: creds.userID,
    email: creds.email || "",
    name: creds.name || "",
    machineID: creds.machineID || getMachineId(),
  };
}

/** Seed / replace the in-process identity cache after login, refresh, or resolve. */
export function rememberQoderIdentity(
  providerID: string,
  creds: Pick<QoderCredentials, "access" | "userID" | "email" | "name" | "machineID">,
): void {
  if (!creds?.access || !creds?.userID) return;
  clearProviderIdentityCache(providerID);
  identityMemoryCache.set(identityCacheKey(providerID, creds.access), toQoderIdentity(creds));
}

/** Test helper: clear process-local identity cache. */
export function clearQoderIdentityMemoryCache(): void {
  identityMemoryCache.clear();
}

/** Test helper: inspect cached identity values (must never include access/refresh). */
export function peekQoderIdentityMemoryCache(): QoderIdentity[] {
  return [...identityMemoryCache.values()].map((v) => ({ ...v }));
}

/** Return the PAT exposed through the environment for a provider mode. */
export function getQoderPatForMode(mode: string): string {
  if (isQoderCNMode(mode)) return getQoderCNPat();
  return process.env.QODER_API_KEY || process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || "";
}

function saveCredentialsToAuthFile(providerID: string, credentials: OAuthCredentials): void {
  try {
    const dir = dirname(AUTH_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let auth: Record<string, unknown> = {};
    if (existsSync(AUTH_FILE)) {
      try {
        auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      } catch {}
    }
    auth[providerID] = { type: "oauth", ...credentials };
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.error(`[pi-provider-qoder] Failed to write auth storage for ${providerID}:`, err);
  }
}

/** Exchange an environment PAT before pi resolves its initial model. */
export async function autoLoginQoderFromEnvironment(providerID: string, mode: string): Promise<void> {
  const pat = getQoderPatForMode(mode);
  if (!pat) return;

  // An explicitly supplied PAT is authoritative. Re-exchange on startup to avoid
  // silently using an old account's credentials.
  const credentials = await credentialsFromPat(pat, mode);

  saveCredentialsToAuthFile(providerID, credentials);
  const qCreds = credentials as QoderCredentials;
  rememberQoderIdentity(providerID, qCreds);

  // Wait for the model cache before the provider is registered so `pi --list-models`
  // sees the live catalog.
  await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode);
}

/**
 * Read the Qoder identity from pi's own auth store. Sync fast path only.
 * Only trusts auth.json when it belongs to THIS access token — otherwise OMP
 * may have rotated to a new account while auth.json still holds a stale userID,
 * and mixing them causes opaque gateway 500s.
 */
export function getCachedCredentials(accessToken: string, providerID = "qoder"): QoderCredentials | null {
  if (existsSync(AUTH_FILE)) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      const creds = auth?.[providerID] || (providerID === "qoder" ? auth?.qoder : null);
      if (creds?.userID && typeof creds.access === "string" && creds.access === accessToken) {
        return creds as QoderCredentials;
      }
    } catch {}
  }
  return null;
}

/**
 * Resolve Qoder identity for chat/COSY requests.
 *
 * Cold-start stream only has the access token (options.apiKey) — not refresh —
 * so recovery must not depend on decoding the DB refresh field.
 *
 * Order:
 * 1. auth.json fast path (sync) — only when stored access === accessToken
 * 2. process-local memory cache keyed by (providerID, sha256(accessToken)); identity-only values
 * 3. /userinfo with the access token
 *
 * Never invents a placeholder userID. Stale auth.json (old userID + new access)
 * must miss the fast path and re-resolve via /userinfo.
 */
export async function resolveQoderIdentity(
  accessToken: string,
  providerID = "qoder",
  mode?: string,
  parentSignal?: AbortSignal,
): Promise<QoderCredentials> {
  const resolvedMode = mode ?? (providerID === "qoder-cn" ? "cn" : getQoderMode());
  const providerLabel = isQoderCNMode(resolvedMode) ? "Qoder CN" : "Qoder";

  const fromFile = getCachedCredentials(accessToken, providerID);
  if (fromFile?.userID) {
    const identity = toQoderIdentity({
      userID: fromFile.userID,
      email: fromFile.email || getQoderUserEmailFallback(resolvedMode),
      name: fromFile.name || (isQoderCNMode(resolvedMode) ? "Qoder CN User" : "Qoder User"),
      machineID: fromFile.machineID || getMachineId(),
    });
    rememberQoderIdentity(providerID, { access: accessToken, ...identity });
    return { access: accessToken, refresh: "", expires: 0, ...identity };
  }

  const cached = identityMemoryCache.get(identityCacheKey(providerID, accessToken));
  if (cached?.userID) {
    return { access: accessToken, refresh: "", expires: 0, ...cached };
  }

  const info = await fetchUserInfo(accessToken, resolvedMode, parentSignal);
  if (!info.userID) {
    throw new Error(
      `${providerLabel} identity unavailable: ~/.pi/agent/auth.json has no userID and /userinfo did not return one. ` +
        `Re-login with "/login ${isQoderCNMode(resolvedMode) ? "qoder-cn" : "qoder"}" ` +
        `(VPC: ensure QODER_VPC_INSTANCE is set; do not use a placeholder userID).`,
    );
  }

  const identity: QoderIdentity = {
    userID: info.userID,
    email: info.email || getQoderUserEmailFallback(resolvedMode),
    name: info.name || (isQoderCNMode(resolvedMode) ? "Qoder CN User" : "Qoder User"),
    machineID: getMachineId(),
  };
  rememberQoderIdentity(providerID, { access: accessToken, ...identity });
  return { access: accessToken, refresh: "", expires: 0, ...identity };
}

function providerIDForMode(mode: string): string {
  return isQoderCNMode(mode) ? "qoder-cn" : "qoder";
}

async function loginQoderForMode(callbacks: OAuthLoginCallbacks, mode: string): Promise<OAuthCredentials> {
  // 1. Try environment variables first (PAT). A PAT (pt-...) must be exchanged
  //    for a short-lived job token before use — credentialsFromPat handles it.
  const pat = isQoderCNMode(mode) ? getQoderCNPat() : process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT;
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, mode);
      const qCreds = creds as QoderCredentials;
      rememberQoderIdentity(providerIDForMode(mode), qCreds);
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
      return creds;
    } catch {
      // Fall through to interactive login if PAT exchange fails.
    }
  }

  // 2. Interactive login (CN only supports PAT prompt; global supports device flow).
  const creds = await interactiveLogin(callbacks, mode);
  try {
    const qCreds = creds as QoderCredentials;
    if (qCreds.userID) {
      rememberQoderIdentity(providerIDForMode(mode), qCreds);
      updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
    }
  } catch {}
  return creds;
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, getQoderMode());
}

export async function loginQoderCN(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  return loginQoderForMode(callbacks, "cn");
}

export async function refreshQoderToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, getQoderMode());
}

export async function refreshQoderTokenCN(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return refreshQoderTokenForMode(credentials, "cn");
}

async function refreshQoderTokenForMode(credentials: OAuthCredentials, mode: string): Promise<OAuthCredentials> {
  // Job-token credentials: refresh via jrt. Never re-persist a plaintext PAT.
  if (isPatRefresh(credentials.refresh)) {
    const decoded = decodePatRefresh(credentials.refresh);
    const prev = credentials as Partial<QoderCredentials>;
    const userID = decoded.userID || prev.userID || "";
    const machineID = decoded.machineID || prev.machineID || getMachineId();
    const email = prev.email || "";
    const name = prev.name || "";
    const providerLabel = isQoderCNMode(mode) ? "Qoder CN" : "Qoder";

    const finalize = (refreshed: OAuthCredentials): OAuthCredentials => {
      if (typeof refreshed.refresh === "string") {
        const parts = refreshed.refresh.split("|");
        if (parts.some((part) => part.startsWith("pt-") || (decoded.pat && part === decoded.pat))) {
          throw new Error(`${providerLabel} refresh refused to persist a plaintext PAT in refresh`);
        }
      }
      const qCreds = refreshed as QoderCredentials;
      if (qCreds.userID) {
        rememberQoderIdentity(providerIDForMode(mode), qCreds);
        updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, mode).catch(() => {});
      }
      return refreshed;
    };

    // 1) Preferred: server jrt refresh.
    if (decoded.jobRefreshToken) {
      try {
        const exchange = await refreshJobToken(decoded.jobRefreshToken, mode);
        return finalize(credentialsFromJobTokens(exchange, { userID, email, name, machineID }, mode));
      } catch {
        // Fall through to one-shot env PAT / legacy migrate.
      }
    }

    // 2) One-shot env PAT (not from persisted refresh).
    const envPat = isQoderCNMode(mode)
      ? getQoderCNPat()
      : process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT || "";
    if (envPat) {
      try {
        return finalize(await credentialsFromPat(envPat, mode));
      } catch {
        // Fall through.
      }
    }

    // 3) Legacy migrate: if an old refresh still embeds a PAT, use it once to
    //    obtain jrt-only credentials — then never write the PAT back.
    if (decoded.legacyEmbeddedPat && decoded.pat) {
      try {
        return finalize(await credentialsFromPat(decoded.pat, mode));
      } catch {
        // Fall through to hard failure.
      }
    }

    throw new Error(
      `${providerLabel} job token refresh failed. Re-login with "/login ${isQoderCNMode(mode) ? "qoder-cn" : "qoder"}". ` +
        `PAT is no longer stored in refresh; set a PAT env var only for one-shot login, or paste it interactively.`,
    );
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;
  const prevName = prev.name || "";
  const prevEmail = prev.email || "";

  const refreshURL = getQoderRefreshURL(mode);
  try {
    const data = await withQoderHttpTimeout("token refresh", undefined, async (signal) => {
      const response = await fetch(refreshURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credentials.access}`,
          Accept: "application/json",
          "User-Agent": "pi-provider-qoder",
        },
        body: JSON.stringify({ refreshToken }),
        signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };
    });

    if (data) {
      const newAccess = data.token;
      const newRefresh = data.refresh_token || refreshToken;

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      const refreshed = {
        ...credentials,
        refresh: `${newRefresh}|${userID}|${machineID}`,
        access: newAccess,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: prevEmail,
        name: prevName,
        machineID,
      } as QoderCredentials;

      if (userID) {
        rememberQoderIdentity(providerIDForMode(mode), refreshed);
        updateQoderModelsCache(newAccess, userID, prevName, prevEmail, mode).catch(() => {});
      }
      return refreshed;
    }
  } catch {}

  // Fallback: extend validity slightly to buy time (Qoder tokens are long-lived).
  return {
    ...credentials,
    expires: Date.now() + 60 * 60 * 1000,
  };
}
