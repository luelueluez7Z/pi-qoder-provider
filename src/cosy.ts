import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Qoder API identity + signing primitives.
//
// The Qoder model gateway authenticates requests with a "COSY" envelope:
//   - A per-request AES-CBC key encrypts the user identity block.
//   - That AES key is wrapped with Qoder's public RSA key.
//   - An MD5 signature binds the base64 payload, the wrapped key, a timestamp,
//     the request body and the request path.
// The exact field names, header names and client identity constants below are
// part of the wire protocol and must match what the current qodercli sends.
// ---------------------------------------------------------------------------

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

// Client identity constants. Out-of-date values cause the model endpoint to
// return a reduced catalog, so keep these aligned with the current Qoder CLI.
const IDE_VERSION = "1.1.3";
const CLIENT_TYPE = "5";
const DATA_POLICY = "disagree";
const LOGIN_VERSION = "v2";
const MACHINE_TYPE_MAGIC = "5";

const MACHINE_OS =
  process.platform === "win32"
    ? process.arch === "arm64"
      ? "aarch64_windows"
      : "x86_64_windows"
    : process.arch === "arm64"
      ? "aarch64_linux"
      : "x86_64_linux";

const MODE_ENV = process.env.QODER_REGION || process.env.QODER_BACKEND || process.env.QODER_MODE || "";

const VPC_DOMAIN = "vpc.qoder.com.cn";

export type QoderMode = "global" | "cn";

/** A single authenticated identity, enough to sign requests for a provider. */
export interface CosyIdentity {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID?: string;
}

interface UserInfo {
  uid: string;
  security_oauth_token: string;
  name: string;
  aid: string;
  email: string;
}

interface CosyPayload {
  version: string;
  requestId: string;
  info: string;
  cosyVersion: string;
  ideVersion: string;
}

// ---------------------------------------------------------------------------
// Mode + endpoint selection (incl. enterprise VPC)
// ---------------------------------------------------------------------------

export function getQoderMode(modeOverride?: string): QoderMode {
  const mode = (modeOverride || MODE_ENV).toLowerCase();
  if (["cn", "china", "qodercn", "qoder-cn"].includes(mode)) return "cn";
  if (["global", "intl", "international", "qoder"].includes(mode)) return "global";
  // A CN-only PAT in the environment is treated as a request for CN mode.
  if (getQoderCNPat() && !(process.env.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PAT)) {
    return "cn";
  }
  return "global";
}

export function isQoderCNMode(modeOverride?: string): boolean {
  return getQoderMode(modeOverride) === "cn";
}

/** True when the value looks like a Qoder PAT (pt-...), not a job token / opaque key. */
export function isQoderPatValue(value?: string): boolean {
  return Boolean(value?.trim().startsWith("pt-"));
}

/** Resolve a Qoder CN PAT from the environment. Never treat jt-/opaque keys as PATs. */
export function getQoderCNPat(): string {
  const dedicated = process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PAT || "";
  if (dedicated.trim()) return dedicated.trim();
  const apiKey = process.env.QODER_API_KEY || "";
  return isQoderPatValue(apiKey) ? apiKey.trim() : "";
}

function parseQoderVPCInstance(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  let candidate = value.trim().toLowerCase();
  try {
    candidate = new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname;
  } catch {
    return undefined;
  }
  const suffix = `.${VPC_DOMAIN}`;
  if (candidate.endsWith(suffix)) {
    candidate = candidate.slice(0, -suffix.length);
    if (candidate.endsWith("-gateway") || candidate.endsWith("-openapi")) {
      candidate = candidate.slice(0, -8);
    }
  } else if (candidate.includes(".")) {
    return undefined;
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate) ? candidate : undefined;
}

function getQoderVPCInstance(endpointOverride?: string): string | undefined {
  return parseQoderVPCInstance(
    endpointOverride ||
      process.env.QODER_VPC_INSTANCE ||
      process.env.QODER_VPC_ENDPOINT ||
      process.env.QODERCN_VPC_ENDPOINT ||
      process.env.QODERCN_CLI_VPC_ENDPOINT ||
      process.env.QODER_CN_BASE_URL ||
      process.env.QODER_CN_OPENAPI_URL ||
      process.env.QODER_CN_CENTER_URL,
  );
}

function getQoderVPCServiceUrl(service: "gateway" | "openapi", endpointOverride?: string): string | undefined {
  const instance = getQoderVPCInstance(endpointOverride);
  return instance ? `https://${instance}-${service}.${VPC_DOMAIN}` : undefined;
}

export function getQoderBaseUrl(mode?: string): string {
  if (isQoderCNMode(mode)) {
    const override = process.env.QODER_CN_BASE_URL;
    const url = getQoderVPCServiceUrl("gateway", override) || override || "https://gateway.qoder.com.cn/";
    return url.endsWith("/") ? url : `${url}/`;
  }
  return "https://api3.qoder.sh/";
}

export function getQoderOpenApiUrl(mode?: string): string {
  if (isQoderCNMode(mode)) {
    const override = process.env.QODER_CN_OPENAPI_URL;
    const url = getQoderVPCServiceUrl("openapi", override) || override || "https://openapi.qoder.com.cn";
    return url.replace(/\/+$/, "");
  }
  return "https://openapi.qoder.sh";
}

export function getQoderCenterUrl(mode?: string): string {
  if (isQoderCNMode(mode)) {
    const override = process.env.QODER_CN_CENTER_URL;
    const url = getQoderVPCServiceUrl("gateway", override) || override || "https://gateway.qoder.com.cn";
    return url.replace(/\/+$/, "");
  }
  return "https://center.qoder.sh";
}

/** Model catalog endpoint. `Encode=1` is required — without it the service
 *  returns a reduced catalog (e.g. Cantus/cmodel is missing). */
export function getQoderModelListURL(mode?: string): string {
  return `${getQoderBaseUrl(mode)}algo/api/v2/model/list?Encode=1`;
}

/** Streaming chat endpoint. */
export function getQoderChatURL(mode?: string): string {
  return `${getQoderBaseUrl(mode)}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

/** PAT -> job-token exchange endpoint. */
export function getQoderExchangeURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v1/jobToken/exchange`;
}

/** Job-token refresh endpoint (server-issued jrt-...). */
export function getQoderJobTokenRefreshURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v1/jobToken/refresh`;
}

/** User profile endpoint. */
export function getQoderUserInfoURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v1/userinfo`;
}

/** Quota/usage endpoint. */
export function getQoderUsageURL(mode?: string): string {
  return `${getQoderOpenApiUrl(mode)}/api/v2/quota/usage`;
}

/** Token refresh endpoint (device-flow credentials). */
export function getQoderRefreshURL(mode?: string): string {
  return `${getQoderCenterUrl(mode)}/algo/api/v3/user/refresh_token`;
}

/** Public or VPC tenant dashboard origin (no trailing slash). */
export function getQoderManageUrl(mode?: string): string {
  if (isQoderCNMode(mode)) {
    const instance = getQoderVPCInstance();
    if (instance) return `https://${instance}.${VPC_DOMAIN}`;
    return "https://qoder.com.cn";
  }
  return "https://qoder.com";
}

/** Where users create/copy a PAT (public CN or VPC tenant integrations page). */
export function getQoderIntegrationsUrl(mode?: string): string {
  return `${getQoderManageUrl(mode)}/account/integrations`;
}

export function getQoderUserEmailFallback(mode?: string): string {
  return isQoderCNMode(mode) ? "user@qoder.com.cn" : "user@qoder.com";
}

// ---------------------------------------------------------------------------
// CN friendly model IDs
// ---------------------------------------------------------------------------

/** Map a CN-friendly model id back to the internal Qoder CN model key. */
export function getQoderCNDirectModel(modelID?: string): string {
  return (
    {
      "qoder-cn": "auto",
      "qwen3.7-max": "qmodel_latest",
      "qwen3.7-plus": "qmodel",
      "qwen3.6-plus": "qmodel",
      "qwen3.6-flash": "q36fmodel",
      "deepseek-v4-pro": "dmodel",
      "deepseek-v4-flash": "dfmodel",
      "glm-5.2": "gm51model",
      "glm-5.1": "gm51model",
      "kimi-k2.6": "kmodel",
      "minimax-m2.7": "mmodel",
      "minimax-m3": "mmodel",
    }[modelID || ""] ||
    modelID ||
    "auto"
  );
}

const CN_FRIENDLY_MODELS: Record<string, { id: string; name: string }> = {
  auto: { id: "auto", name: "Auto · Qoder CN" },
  "qoder-cn": { id: "qoder-cn", name: "Auto · Qoder CN" },
  qmodel_latest: { id: "qwen3.7-max", name: "Qwen 3.7 Max · Qoder CN" },
  qmodel: { id: "qwen3.7-plus", name: "Qwen 3.7 Plus · Qoder CN" },
  q36fmodel: { id: "qwen3.6-flash", name: "Qwen 3.6 Flash · Qoder CN" },
  qfmodel: { id: "qwen3.6-flash", name: "Qwen 3.6 Flash · Qoder CN" },
  dmodel: { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro · Qoder CN" },
  dfmodel: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Qoder CN" },
  gm51model: { id: "glm-5.2", name: "GLM 5.2 · Qoder CN" },
  kmodel: { id: "kimi-k2.6", name: "Kimi K2.6 · Qoder CN" },
  mmodel: { id: "minimax-m2.7", name: "MiniMax M2.7 · Qoder CN" },
};

function prettifyCNModelName(name: string): string {
  const pretty = (name || "Qoder CN Model")
    .replace(/Qwen(\d)/g, "Qwen $1")
    .replace(/Qwen([\d.]+)-/g, "Qwen $1 ")
    .replace(/DeepSeek\s*V(\d)-/g, "DeepSeek V$1 ")
    .replace(/\s+/g, " ")
    .trim();
  return pretty.includes("Qoder CN") ? pretty : `${pretty} · Qoder CN`;
}

export function getQoderCNFriendlyModelInfo(key: string, display?: string): { id: string; name: string } {
  return CN_FRIENDLY_MODELS[key] || { id: key, name: prettifyCNModelName(display || key) };
}

export function toQoderCNFriendlyModel<T extends { id: string; name: string }>(model: T): T {
  const info = getQoderCNFriendlyModelInfo(model.id, model.name);
  return {
    ...model,
    id: info.id,
    name: info.name,
  };
}

// ---------------------------------------------------------------------------
// Global friendly model IDs
// ---------------------------------------------------------------------------

/** Map a global friendly model id back to the internal Qoder model key. */
export function getQoderGlobalDirectModel(modelID?: string): string {
  return (
    {
      qoder: "auto",
      "qoder-auto": "auto",
      auto: "auto",
      ultimate: "ultimate",
      performance: "performance",
      efficient: "efficient",
      lite: "lite",
      cantus: "cmodel",
      "qwen3.8-max": "qmodel_38max",
      "qwen3.8-max-preview": "qmodel_38max",
      "qwen3.7-max": "qmodel_latest",
      "qwen3.7-plus": "qmodel",
      "kimi-k3": "kmodel_latest",
      "kimi-k2.7-code": "kmodel",
      "glm-5.3": "gmodel",
      "glm-5.2": "gm51model",
      "deepseek-v4-pro": "dmodel",
      "deepseek-v4-flash": "dfmodel",
      "minimax-m3": "mmodel",
    }[modelID || ""] ||
    modelID ||
    "auto"
  );
}

const GLOBAL_FRIENDLY_MODELS: Record<string, { id: string; name: string }> = {
  auto: { id: "auto", name: "Qoder Auto" },
  ultimate: { id: "ultimate", name: "Qoder Ultimate" },
  performance: { id: "performance", name: "Qoder Performance" },
  efficient: { id: "efficient", name: "Qoder Efficient" },
  lite: { id: "lite", name: "Qoder Lite" },
  cmodel: { id: "cantus", name: "Cantus" },
  qmodel_38max: { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
  qmodel_preview: { id: "qwen3.8-max-preview", name: "Qwen 3.8 Max Preview" },
  qmodel_latest: { id: "qwen3.7-max", name: "Qwen 3.7 Max" },
  qmodel: { id: "qwen3.7-plus", name: "Qwen 3.7 Plus" },
  kmodel_latest: { id: "kimi-k3", name: "Kimi K3" },
  kmodel: { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
  gmodel: { id: "glm-5.3", name: "GLM 5.3" },
  gm51model: { id: "glm-5.2", name: "GLM 5.2" },
  dmodel: { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  dfmodel: { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  mmodel: { id: "minimax-m3", name: "MiniMax M3" },
};

export function getQoderGlobalFriendlyModelInfo(key: string, display?: string): { id: string; name: string } {
  return GLOBAL_FRIENDLY_MODELS[key] || { id: key, name: display || key };
}

export function toQoderGlobalFriendlyModel<T extends { id: string; name: string }>(model: T): T {
  const info = getQoderGlobalFriendlyModelInfo(model.id, model.name);
  return {
    ...model,
    id: info.id,
    name: info.name,
  };
}

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

function rsaEncryptBase64(data: Buffer | string): string {
  const encrypted = crypto.publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    typeof data === "string" ? Buffer.from(data) : data,
  );
  return encrypted.toString("base64");
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
}

/** The path used for signing drops the leading `/algo` prefix. */
function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) sigPath = sigPath.substring("/algo".length);
  return sigPath;
}

// ---------------------------------------------------------------------------
// Machine id (persistent, shared with a locally installed qodercli)
// ---------------------------------------------------------------------------

export function getMachineId(): string {
  const paths = [join(homedir(), ".qoder", ".auth", "machine_id"), join(homedir(), ".pi", "agent", "qoder-machine-id")];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const val = readFileSync(p, "utf8").trim();
        if (val) return val;
      } catch {}
    }
  }
  const newId = crypto.randomUUID();
  try {
    const savePath = paths[1];
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, newId, "utf8");
  } catch {}
  return newId;
}

// ---------------------------------------------------------------------------
// COSY request signing
// ---------------------------------------------------------------------------

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyIdentity,
): Record<string, string> {
  if (!creds.userID) throw new Error("cosy: user id is empty");
  if (!creds.authToken) throw new Error("cosy: auth token is empty");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo: UserInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  };

  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();

  const cosyPayload: CosyPayload = {
    version: "v1",
    requestId,
    info: infoB64,
    cosyVersion: IDE_VERSION,
    ideVersion: "",
  };
  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
  const sigPath = computeSigPath(requestURL);

  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString("utf8") : body) : "";
  const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`;
  const sig = crypto.createHash("md5").update(sigInput).digest("hex");

  const bodyHash = crypto
    .createHash("md5")
    .update(body || "")
    .digest("hex");
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";

  const machineID = creds.machineID || getMachineId();

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": IDE_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": MACHINE_TYPE_MAGIC,
    "Cosy-Machineos": MACHINE_OS,
    "Cosy-Clienttype": CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Debug logging + HTTP error formatting
// ---------------------------------------------------------------------------

function isCosyDebugEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.QODER_COSY_DEBUG || "").toLowerCase());
}

export function logCosyRequest(method: string, requestURL: string, headers: Record<string, string>): void {
  if (!isCosyDebugEnabled()) return;
  console.error(
    `[qoder:cosy] request ${JSON.stringify({
      method,
      url: requestURL,
      cosyDate: headers["Cosy-Date"],
      cosySigpath: headers["Cosy-Sigpath"],
      cosyBodyhash: headers["Cosy-Bodyhash"],
      cosyBodylength: headers["Cosy-Bodylength"],
    })}`,
  );
}

export async function logCosyResponse(requestURL: string, response: Response): Promise<void> {
  if (!isCosyDebugEnabled()) return;
  let bodyPreview: string | undefined;
  if (!response.ok) {
    try {
      bodyPreview = (await response.clone().text()).slice(0, 200);
    } catch {
      bodyPreview = "<unavailable>";
    }
  }
  console.error(
    `[qoder:cosy] response ${JSON.stringify({
      url: requestURL,
      status: response.status,
      statusText: response.statusText,
      ...(bodyPreview === undefined ? {} : { bodyPreview }),
    })}`,
  );
}

function isQoderTenantDashboardHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const suffix = `.${VPC_DOMAIN}`;
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  return Boolean(prefix) && !prefix.includes(".") && !prefix.endsWith("-gateway") && !prefix.endsWith("-openapi");
}

/** Enrich Qoder HTTP failures with VPC/CSRF guidance without leaking secrets. */
export function formatQoderHttpError(
  kind: "api" | "pat-exchange",
  status: number,
  statusText: string,
  bodyText: string,
  requestURL?: string,
): string {
  const preview = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
  const prefix =
    kind === "pat-exchange"
      ? `Qoder PAT exchange failed: ${status} ${statusText}`
      : `Qoder API request failed: ${status} ${statusText}`;
  const base = preview ? `${prefix}. Response: ${preview}` : prefix;

  let host = "";
  if (requestURL) {
    try {
      host = new URL(requestURL).hostname.toLowerCase();
    } catch {
      host = "";
    }
  }

  const hints: string[] = [];
  if (/CSRFInvalid/i.test(bodyText)) {
    if (host && isQoderTenantDashboardHost(host)) {
      hints.push(
        `Request hit the tenant dashboard host (${host}). Use the derived API hosts instead: https://<instance>-gateway.vpc.qoder.com.cn and https://<instance>-openapi.vpc.qoder.com.cn (set QODER_VPC_INSTANCE=<instance>).`,
      );
    } else {
      hints.push(
        "CSRFInvalid usually means the request reached web/session middleware instead of the VPC gateway/OpenAPI service. Set QODER_VPC_INSTANCE (or QODERCN_VPC_ENDPOINT) and retry with QODER_COSY_DEBUG=1.",
      );
    }
  }
  if (/open_access_token not found/i.test(bodyText)) {
    hints.push(
      "The VPC OpenAPI host could not resolve a tenant-side access record for this PAT. Create/use a PAT from the VPC tenant dashboard.",
    );
  }

  return hints.length > 0 ? `${base} Hint: ${hints.join(" ")}` : base;
}

// ---------------------------------------------------------------------------
// Upstream (SSE envelope) error parsing + friendly messages
// ---------------------------------------------------------------------------

/** Queue state returned inside the 10605 "model queued" error payload. */
export interface QoderQueueInfo {
  isQueued?: boolean;
  modelKey?: string;
  queueCount?: number;
  queueType?: string;
  retryAfterSeconds?: number;
  serviceAvailable?: boolean;
  waitTime?: number;
}

export interface QoderUpstreamErrorInfo {
  code: string;
  message?: string;
  queue?: QoderQueueInfo;
}

/**
 * Qoder reports business errors inside the SSE envelope as deeply nested JSON:
 *   { "code":"403", "message":"{\"code\":\"10605\",\"message\":\"{...queue...}\"}" }
 * Unwrap the layers and surface the innermost code plus the queue state.
 * Returns null when the body is not this envelope shape.
 */
export function parseQoderUpstreamError(body: string): QoderUpstreamErrorInfo | null {
  try {
    const outer = JSON.parse(body) as Record<string, unknown>;
    const code = typeof outer.code === "string" ? outer.code : String(outer?.code ?? "");

    let inner: Record<string, unknown> | null = null;
    try {
      inner = typeof outer.message === "string" ? (JSON.parse(outer.message) as Record<string, unknown>) : null;
    } catch {}

    const finalCode = inner && typeof inner.code === "string" ? inner.code : code;
    if (inner && typeof inner.message === "string") {
      try {
        const queue = JSON.parse(inner.message) as QoderQueueInfo;
        if (
          queue &&
          (queue.isQueued !== undefined || queue.modelKey !== undefined || queue.retryAfterSeconds !== undefined)
        ) {
          return { code: finalCode, message: inner.message, queue };
        }
      } catch {}
    }

    const fallbackMessage = typeof outer.message === "string" ? outer.message : undefined;
    return {
      code: finalCode,
      message: (inner && typeof inner.message === "string" ? inner.message : undefined) ?? fallbackMessage,
    };
  } catch {
    return null;
  }
}

/** Friendly Chinese hints for the most common Qoder business error codes. */
const QODER_ERROR_HINTS: Record<string, string> = {
  "101": "请求签名无效，请重试。",
  "102": "请求超时，请稍后重试。",
  "103": "重复的请求 ID，请重试。",
  "105": "登录已过期，请重新登录后再试。",
  "110": "今日聊天额度已用完，请明天再试或升级套餐。",
  "112": "积分额度已用完，请升级订阅套餐获取更多资源。",
  "113": "已达到用量上限，请升级订阅套餐。",
  "115": "本月 Lite 模型额度已用完，请升级套餐。",
  "116": "积分已用完，将在下个周期重置，或可前往官网购买积分。",
  "117": "积分已用完，可联系管理员或前往官网查看用量。",
  "118": "积分已用完：新用户请等待 3-5 分钟免费额度到账，订阅用户等待下个周期重置。",
  "119": "今日 Qwen-Coder-Qoder 模型免费额度已用完，升级套餐可解锁更多模型。",
  "406": "会话包含敏感内容被拒绝，请切换模型或新开一个会话。",
  "408": "响应超时，请重试。",
  "409": "上游发生错误，请重试。",
  "416": "会话可能触发了模型安全策略，请切换模型或新开会话。",
  "429": "当前模型繁忙，请稍后重试或切换到其他模型。",
  "500": "上游服务器错误，请稍后重试。",
  "80404": "该模型在社区版不可用，请切换到已配置的自定义模型。",
  "90000": "当前或历史消息包含图片，但所选模型不支持图片输入，请切换模型或新开会话。",
  "48711": "该操作需要升级订阅套餐。",
  "48712": "所选模型不受支持。",
  "48713": "所选模型当前不可用。",
};

/** Format an SSE-envelope upstream error into a readable message. */
export function formatQoderUpstreamError(status: number, body: string, modelName?: string): string {
  const info = parseQoderUpstreamError(body);
  if (!info) return `Upstream status ${status}: ${body}`;

  if (info.code === "10605" && info.queue) {
    const q = info.queue;
    const waitSec = typeof q.retryAfterSeconds === "number" ? q.retryAfterSeconds : 30;
    const queueCount = typeof q.queueCount === "number" && q.queueCount > 0 ? q.queueCount : undefined;
    const model = modelName || (q.modelKey ? q.modelKey : "当前模型");
    const queuePart = queueCount !== undefined ? `（队列中约 ${queueCount} 个请求）` : "";
    return (
      `${model} 当前正在排队${queuePart}，暂时无法响应，预计等待约 ${waitSec} 秒。` +
      `请稍后重试，或切换到其他模型（如 DeepSeek V4 Pro / Flash）。`
    );
  }

  const hint = QODER_ERROR_HINTS[info.code];
  if (hint) return `${hint}（错误码 ${info.code}）`;
  return `Qoder 上游返回错误（HTTP ${status}${info.code ? `，错误码 ${info.code}` : ""}）: ${info.message || body}`;
}
