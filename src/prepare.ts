import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  withoutInitialSystemMessage,
} from "@earendil-works/pi-ai";
import {
  getMachineId,
  getQoderCNDirectModel,
  getQoderGlobalDirectModel,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
} from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { resolveQoderIdentity } from "./oauth.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";
import { checkQoderQuota } from "./usage.js";

/**
 * Everything both transports (legacy COSY gateway + v2 model server) need from
 * the pi call: identity, resolved Qoder model key, replayed messages, tools and
 * generation parameters. Built once so the two transports cannot drift.
 */
export interface PreparedQoderRequest {
  providerMode: string;
  accessToken: string;
  userID: string;
  name: string;
  email: string;
  machineID: string;
  qoderModel: string;
  modelConfig: NonNullable<ReturnType<typeof getCachedModelConfig>>;
  isReasoning: boolean;
  maxOutputTokens: number;
  systemText: string;
  normalizedMessages: ReturnType<typeof transformMessagesForQoder>;
  lastUserText: string;
  sessionID: string;
  maxTokens: number;
  reasoningEffort: string;
  enableThinking: boolean;
  contextWindow: number | undefined;
  toolsRaw: ReturnType<typeof transformTools> | undefined;
}

export function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Resolve the user's context window preference for a model from Qoder's own
 * settings file (~/.qoder/settings.json). This honors what the user chose via
 * `/context-window` in qodercli:
 *   - model.contextWindow                      (global default)
 *   - model.preferences.<qoderModel>.contextWindow  (per-model override)
 * Returns undefined when unset / unreadable, so the gateway applies its default.
 */
export function resolveQoderContextWindow(qoderModel: string): number | undefined {
  try {
    const settingsPath = join(homedir(), ".qoder", "settings.json");
    if (!existsSync(settingsPath)) return undefined;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      model?: {
        contextWindow?: unknown;
        preferences?: Record<string, { contextWindow?: unknown }>;
      };
    };
    const perModel = settings.model?.preferences?.[qoderModel]?.contextWindow;
    if (typeof perModel === "number" && perModel > 0) return perModel;
    const global = settings.model?.contextWindow;
    if (typeof global === "number" && global > 0) return global;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function prepareQoderRequest(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): Promise<PreparedQoderRequest> {
  const providerMode = model.provider === "qoder-cn" ? "cn" : getQoderMode();
  const accessToken = options?.apiKey;
  if (!accessToken) {
    throw new Error(
      isQoderCNMode(providerMode)
        ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
        : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
    );
  }

  // Resolve identity: auth.json fast path → in-process cache → /userinfo(access).
  // Cold start only has options.apiKey (access); do NOT decode refresh here.
  // Never invent a placeholder userID — the gateway returns opaque HTTP 500.
  const identity = await resolveQoderIdentity(accessToken, model.provider, providerMode, options?.signal);
  const userID = identity.userID;
  const name = identity.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User");
  const email = identity.email || getQoderUserEmailFallback(providerMode);
  const machineID = identity.machineID || getMachineId();

  // Pre-flight quota check: when the account is out of credits, the
  // upstream answers the chat endpoint with HTTP 200 but never streams —
  // the turn would hang with no output. Detect it up front and fail fast
  // with a friendly message instead. The check is cached for 60s so normal
  // usage doesn't pay an extra round-trip on every turn.
  const quotaCheck = await checkQoderQuota(accessToken, providerMode, options?.signal);
  if (quotaCheck.exhausted) {
    throw new Error(quotaCheck.message || "Qoder 积分额度已用完，请升级套餐或充值后重试。");
  }

  const aliasKey = isQoderCNMode(providerMode) ? getQoderCNDirectModel(model.id) : getQoderGlobalDirectModel(model.id);
  const cachedConfig = getCachedModelConfig(model.id, providerMode) || getCachedModelConfig(aliasKey, providerMode);
  // Prefer the live catalog wire key over the static alias table: when
  // Qoder rotates a model's key, the friendly-id cache entry still points
  // at the current key while the hardcoded alias goes stale.
  const qoderModel = cachedConfig?.key || aliasKey;
  const modelConfig = cachedConfig || {
    key: qoderModel,
    is_reasoning:
      qoderModel === "ultimate" ||
      qoderModel === "performance" ||
      qoderModel.includes("dmodel") ||
      qoderModel.includes("dfmodel"),
    max_output_tokens: 32768,
    source: "system",
  };
  modelConfig.key = qoderModel;

  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = modelConfig.max_output_tokens || 32768;

  // pi 0.86.0: streamSimple now receives a normalized TranscriptContext.
  // The system prompt and tool declarations live in system messages; replay
  // them (folding mid-conversation system messages into the leading one,
  // since Qoder carries the prompt as a single leading system message) and
  // drop the leading system message before transforming the chat messages.
  const collapsed = collapseSystemMessages(context);
  const systemText = getCurrentSystemPrompt(collapsed.messages);
  const normalizedMessages = transformMessagesForQoder(withoutInitialSystemMessage(collapsed.messages));

  let lastUserText = "";
  for (let i = normalizedMessages.length - 1; i >= 0; i--) {
    if (normalizedMessages[i].role === "user") {
      const content = normalizedMessages[i].content;
      lastUserText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c) => ("text" in c ? c.text : "")).join("")
            : "";
      break;
    }
  }

  // Use a stable session id when pi provides one (per agent session) so the
  // Qoder server can maintain prompt cache affinity across requests.
  const stablePart = stableHash("qoder-session", userID, qoderModel);
  const sessionID = options?.sessionId ? `${stablePart}-${options.sessionId}` : `${stablePart}-${crypto.randomUUID()}`;

  let maxTokens = 32768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (options?.maxTokens && options.maxTokens < maxTokens) maxTokens = options.maxTokens;

  // Map pi's thinking level to the wire level carried by both transports.
  // Levels are none/low/medium/high/xhigh/max; "off"/"minimal" mean none.
  const reasoningLevel = (options?.reasoning as string | undefined) ?? "off";
  const reasoningEffort = reasoningLevel === "off" || reasoningLevel === "minimal" ? "none" : reasoningLevel;
  const enableThinking = reasoningEffort !== "none";

  // Context window: pi's streamSimple has no contextWindow option, so honor
  // the user's Qoder CLI preference from ~/.qoder/settings.json
  // (model.contextWindow or model.preferences.<qoderModel>.contextWindow).
  const contextWindow = resolveQoderContextWindow(qoderModel) ?? undefined;

  const currentTools = getCurrentTools(collapsed.messages);
  const toolsRaw = currentTools.length > 0 ? transformTools(currentTools) : undefined;

  return {
    providerMode,
    accessToken,
    userID,
    name,
    email,
    machineID,
    qoderModel,
    modelConfig,
    isReasoning,
    maxOutputTokens,
    systemText,
    normalizedMessages,
    lastUserText,
    sessionID,
    maxTokens,
    reasoningEffort,
    enableThinking,
    contextWindow,
    toolsRaw,
  };
}
