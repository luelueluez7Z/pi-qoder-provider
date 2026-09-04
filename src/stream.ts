import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import * as PiAi from "@earendil-works/pi-ai";
import {
  buildAuthHeaders,
  createQoderQueueError,
  formatQoderHttpError,
  formatQoderUpstreamError,
  getMachineId,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderGlobalDirectModel,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  logCosyRequest,
  logCosyResponse,
  QoderQueueError,
} from "./cosy.js";
import { withQoderHttpTimeout } from "./http.js";
import { getCachedModelConfig } from "./models.js";
import { resolveQoderIdentity } from "./oauth.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";
import { checkQoderQuota } from "./usage.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
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
function resolveQoderContextWindow(qoderModel: string): number | undefined {
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

/**
 * Max automatic retries after a 10605 "model queued" response, from
 * QODER_QUEUE_RETRY_MAX (default 3; 0 disables auto-retry entirely).
 */
function parseQueueRetryMax(): number {
  const raw = process.env.QODER_QUEUE_RETRY_MAX;
  if (raw === undefined || raw.trim() === "") return 3;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 3;
  return n;
}

/** Sleep for `ms`, resolving early (rejecting) when `signal` aborts. */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Idle timeout (ms) before a stream with no data is declared hung, from
 * QODER_IDLE_TIMEOUT_MS (default 60000; 0 disables). Guards against the
 * upstream answering HTTP 200 and then never streaming (e.g. quota exhausted).
 */
function parseIdleTimeout(): number {
  const raw = process.env.QODER_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 60_000;
  return n;
}

function parseStreamTimeout(): number {
  const raw = process.env.QODER_STREAM_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 5 * 60_000;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 5 * 60_000;
  return n;
}

const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 1 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    try {
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

      const qoderModel = isQoderCNMode(providerMode)
        ? getQoderCNDirectModel(model.id)
        : getQoderGlobalDirectModel(model.id);
      const modelConfig = getCachedModelConfig(qoderModel, providerMode) || {
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

      const normalizedMessages = transformMessagesForQoder(context.messages);
      const systemText = context.systemPrompt || "";

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
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      let maxTokens = 32768;
      if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
      if (options?.maxTokens && options.maxTokens < maxTokens) maxTokens = options.maxTokens;

      // Map pi's thinking level to Qoder's `reasoning_effort` wire parameter.
      // pi levels: off/minimal/low/medium/high/xhigh/max. Qoder accepts:
      // none/low/medium/high/xhigh/max (and "none" when thinking is off).
      const reasoningLevel = (options?.reasoning as string | undefined) ?? "off";
      const reasoningEffort = reasoningLevel === "off" || reasoningLevel === "minimal" ? "none" : reasoningLevel;

      // Context window: pi's streamSimple has no contextWindow option, so honor
      // the user's Qoder CLI preference from ~/.qoder/settings.json
      // (model.contextWindow or model.preferences.<qoderModel>.contextWindow).
      const contextWindow = resolveQoderContextWindow(qoderModel) ?? undefined;

      const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      // Queue-aware auto retry: when the upstream answers with a 10605 "model
      // queued" payload, surface a live notice, wait the server-suggested
      // duration, then re-issue the same request (fresh request_id, same
      // session) instead of failing the turn. If the queue never clears, the
      // original friendly QoderQueueError message surfaces to the user.
      const queueRetryMax = parseQueueRetryMax();
      let queueNoticeIndex: number | null = null;

      stream.push({ type: "start", partial: output });

      const attemptOnce = async (): Promise<void> => {
        // Inner AbortController so both the caller's signal and an idle timeout
        // (hung upstream, e.g. quota exhausted) can tear the fetch down.
        const innerController = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const onExternalAbort = () => {
          innerController.abort();
          void reader?.cancel().catch(() => {});
        };
        let streamTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let streamTimedOut = false;
        options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
        try {
          if (options?.signal?.aborted) throw new Error("aborted");
          const reqBody: Record<string, unknown> = {
            request_id: crypto.randomUUID(),
            request_set_id: recordID,
            chat_record_id: recordID,
            session_id: sessionID,
            stream: true,
            chat_task: "FREE_INPUT",
            is_reply: true,
            is_retry: false,
            source: 1,
            version: "3",
            session_type: "qodercli",
            agent_id: "agent_common",
            task_id: "common",
            code_language: "",
            chat_prompt: "",
            image_urls: null,
            aliyun_user_type: "",
            // Qoder's server ignores the top-level `system` field; inject the system
            // prompt as a leading role:system message instead, which it honors.
            system: "",
            messages: systemText
              ? [{ role: "system", content: systemText }, ...normalizedMessages]
              : normalizedMessages,
            tools: toolsRaw || [],
            parameters: {
              max_tokens: maxTokens,
              ...(reasoningEffort !== "none" ? { reasoning_effort: reasoningEffort } : { reasoning_effort: "none" }),
              ...(contextWindow ? { context_window: contextWindow } : {}),
            },
            chat_context: {
              chatPrompt: "",
              imageUrls: null,
              extra: {
                context: [],
                modelConfig: {
                  key: qoderModel,
                  is_reasoning: isReasoning,
                },
                originalContent: lastUserText,
              },
              features: [],
              text: lastUserText,
            },
            model_config: modelConfig,
            business: {
              product: "cli",
              version: "1.0.0",
              type: "agent",
              stage: "start",
              id: crypto.randomUUID(),
              name: lastUserText.substring(0, 30),
              begin_at: Date.now(),
            },
          };

          if (options?.signal?.aborted) throw new Error("aborted");
          const bodyBytes = Buffer.from(JSON.stringify(reqBody));
          if (bodyBytes.byteLength > MAX_REQUEST_BODY_BYTES) {
            throw new Error(`Qoder request body exceeded ${MAX_REQUEST_BODY_BYTES} bytes`);
          }
          const encodedBody = qoderEncodeBody(bodyBytes);
          const encodedBytes = Buffer.from(encodedBody, "utf8");

          const chatURL = getQoderChatURL(providerMode);

          const headers = buildAuthHeaders(encodedBytes, chatURL, {
            userID,
            authToken: accessToken,
            name,
            email,
            machineID,
          });
          logCosyRequest("POST", chatURL, headers);

          const modelSource = modelConfig.source || "system";

          const response = await withQoderHttpTimeout("chat connection", innerController.signal, (signal) =>
            fetch(chatURL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                "Cache-Control": "no-cache",
                "Accept-Encoding": "identity",
                "X-Model-Key": qoderModel,
                "X-Model-Source": modelSource,
                ...headers,
              },
              body: encodedBytes,
              signal,
            }),
          );
          await withQoderHttpTimeout("chat response logging", innerController.signal, () =>
            logCosyResponse(chatURL, response),
          );

          if (!response.ok) {
            const errText = await withQoderHttpTimeout("chat error body", innerController.signal, () =>
              response.text(),
            );
            throw new Error(formatQoderHttpError("api", response.status, response.statusText, errText, chatURL));
          }

          reader = response.body?.getReader();
          if (!reader) throw new Error("No response body");
          const streamTimeoutMs = parseStreamTimeout();
          if (streamTimeoutMs > 0) {
            streamTimeoutTimer = setTimeout(() => {
              streamTimedOut = true;
              innerController.abort();
              void reader?.cancel().catch(() => {});
            }, streamTimeoutMs);
          }
          const decoder = new TextDecoder();
          let buffer = "";
          let protocolDone = false;
          let finishReasonSeen = false;
          const idleTimeoutMs = parseIdleTimeout();
          let lastDataAt = Date.now();
          const idleTimeoutError = () =>
            new Error(
              "Qoder 模型长时间未返回响应（可能积分已用完或服务繁忙），已中止本次请求。请检查 Qoder 账户额度或稍后重试。",
            );

          let contentBlockIndex = -1;
          let thinkingBlockIndex = -1;
          const toolCallsState: ToolCallState[] = [];

          const thinkingEnabled =
            (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
          const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

          while (true) {
            // A stream that delivers nothing for the idle window is hung — the
            // upstream answered 200 and then went silent (e.g. quota exhausted).
            // Abort and surface a friendly message instead of spinning forever.
            let done: boolean | undefined;
            let value: Uint8Array | undefined;
            if (idleTimeoutMs > 0) {
              let readTimer: ReturnType<typeof setTimeout> | undefined;
              const remainingIdleMs = Math.max(1, idleTimeoutMs - (Date.now() - lastDataAt));
              const idle = new Promise<never>((_, reject) => {
                readTimer = setTimeout(() => {
                  innerController.abort();
                  reject(idleTimeoutError());
                }, remainingIdleMs);
              });
              const readPromise = reader.read();
              // Ignore the late rejection once the idle abort tears the fetch down.
              readPromise.catch(() => {});
              try {
                ({ done, value } = await Promise.race([readPromise, idle]));
              } finally {
                if (readTimer !== undefined) clearTimeout(readTimer);
              }
            } else {
              ({ done, value } = await reader.read());
            }
            const transportDone = done === true;
            if (value && value.byteLength > 0) {
              lastDataAt = Date.now();
              buffer += decoder.decode(value, { stream: !transportDone });
              if (buffer.length > MAX_SSE_BUFFER_CHARS) {
                throw new Error(`Qoder SSE event exceeded ${MAX_SSE_BUFFER_CHARS} characters`);
              }
            } else if (!transportDone) {
              if (idleTimeoutMs > 0 && Date.now() - lastDataAt >= idleTimeoutMs) {
                innerController.abort();
                throw idleTimeoutError();
              }
              // A broken transport can resolve read() repeatedly without making
              // progress. Yield so that it cannot starve terminal input or timers.
              await delayWithAbort(10, innerController.signal);
              continue;
            }

            if (transportDone) {
              const tail = decoder.decode();
              if (tail) buffer += tail;
              if (buffer.length > MAX_SSE_BUFFER_CHARS) {
                throw new Error(`Qoder SSE event exceeded ${MAX_SSE_BUFFER_CHARS} characters`);
              }
              // SSE permits the final event to omit the trailing newline. Flush it
              // through the same parser before deciding whether the stream is valid.
              if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
            }

            while (true) {
              const lineEnd = buffer.indexOf("\n");
              if (lineEnd === -1) break;

              const line = buffer.substring(0, lineEnd).trim();
              buffer = buffer.substring(lineEnd + 1);

              if (!line.startsWith("data:")) continue;
              const dataStr = line.substring(5).trim();
              if (!dataStr) continue;
              if (dataStr === "[DONE]") {
                protocolDone = true;
                break;
              }

              try {
                const parsedEnvelope: unknown = JSON.parse(dataStr);
                if (!isRecord(parsedEnvelope)) throw new Error("Qoder SSE envelope is not an object");
                const envelope = parsedEnvelope;
                const statusCodeValue = envelope.statusCodeValue;
                const status =
                  typeof statusCodeValue === "number"
                    ? statusCodeValue
                    : typeof statusCodeValue === "string" && statusCodeValue.trim() !== ""
                      ? Number(statusCodeValue)
                      : 200;
                if (!Number.isFinite(status)) throw new Error("Qoder SSE envelope has an invalid status code");
                if (status !== 200) {
                  if (typeof envelope.body !== "string") throw new Error("Qoder SSE error envelope has no body");
                  if (process.env.QODER_DEBUG) {
                    console.error(
                      "[pi-provider-qoder] upstream error, sent messages:",
                      JSON.stringify(reqBody.messages, null, 2),
                    );
                  }
                  // A 10605 queue payload becomes a typed QoderQueueError so the
                  // retry loop can auto-wait and re-issue; anything else surfaces
                  // as a friendly error message.
                  const queueError = createQoderQueueError(status, envelope.body, model.name);
                  throw queueError ?? new Error(formatQoderUpstreamError(status, envelope.body, model.name));
                }

                const innerStr = envelope.body;
                if (!innerStr) continue;
                if (typeof innerStr !== "string") throw new Error("Qoder SSE envelope body is not a string");
                if (innerStr === "[DONE]") {
                  protocolDone = true;
                  break;
                }

                const parsedInner: unknown = JSON.parse(innerStr);
                if (!isRecord(parsedInner)) throw new Error("Qoder SSE payload is not an object");
                const inner = parsedInner;
                if (typeof inner.id === "string" && inner.id) output.responseId = inner.id;
                if (typeof inner.model === "string" && inner.model) output.responseModel = inner.model;

                if (inner.usage !== undefined && !isRecord(inner.usage)) {
                  throw new Error("Qoder SSE payload has invalid usage");
                }
                if (inner.usage) {
                  const u = inner.usage as {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    total_tokens?: number;
                    credits?: number;
                    original_credits?: number;
                    completion_tokens_details?: { reasoning_tokens?: number };
                    prompt_tokens_details?: {
                      cacheable_tokens?: number;
                      cached_tokens?: number;
                      cache_write_tokens?: number;
                    };
                  };
                  // pi computes promptTokens = input + cacheRead + cacheWrite (Anthropic
                  // convention: input EXCLUDES cached/written tokens). Qoder follows
                  // OpenAI semantics where prompt_tokens INCLUDES cached tokens, so
                  // subtract cacheRead/cacheWrite to match.
                  const promptTokens = u.prompt_tokens ?? 0;
                  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
                  const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
                  output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
                  output.usage.output = u.completion_tokens ?? 0;
                  output.usage.totalTokens = u.total_tokens ?? 0;
                  output.usage.cacheRead = cacheReadTokens;
                  output.usage.cacheWrite = cacheWriteTokens;

                  // Qoder is credit-based: the request's SSE tail reports the credits it
                  // consumed (usage.credits). Fold that into usage.cost so pi's footer
                  // accumulates the session's total credit spend ($x.xxx). Split
                  // input/output by token share so the cost total stays exact while
                  // per-token numbers remain sane for pi's cache-stats.
                  const credits = u.credits ?? 0;
                  if (credits > 0) {
                    const billedTokens =
                      output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
                    if (billedTokens > 0) {
                      const inputShare = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
                      output.usage.cost.input = (credits * inputShare) / billedTokens;
                      output.usage.cost.output = (credits * output.usage.output) / billedTokens;
                    } else {
                      output.usage.cost.input = credits;
                    }
                    output.usage.cost.total = credits;
                  }
                }

                if (inner.choices !== undefined && !Array.isArray(inner.choices)) {
                  throw new Error("Qoder SSE payload has invalid choices");
                }
                if (Array.isArray(inner.choices) && inner.choices.length > 0) {
                  const choice = inner.choices[0];
                  if (!isRecord(choice)) throw new Error("Qoder SSE payload has an invalid choice");
                  const delta = choice.delta;

                  if (delta) {
                    if (!isRecord(delta)) throw new Error("Qoder SSE payload has an invalid delta");
                    if (delta.reasoning_content !== undefined && typeof delta.reasoning_content !== "string") {
                      throw new Error("Qoder SSE payload has non-string reasoning content");
                    }
                    if (delta.content !== undefined && typeof delta.content !== "string") {
                      throw new Error("Qoder SSE payload has non-string content");
                    }
                    if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
                      throw new Error("Qoder SSE payload has invalid tool calls");
                    }
                    // 1. Reasoning/thinking content (API reasoning channel)
                    if (delta.reasoning_content) {
                      const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                      if (reasoningChunk) {
                        if (thinkingBlockIndex === -1) {
                          thinkingBlockIndex = output.content.length;
                          output.content.push({ type: "thinking", thinking: "" });
                          stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                        }
                        const block = output.content[thinkingBlockIndex] as ThinkingContent;
                        block.thinking += reasoningChunk;
                        stream.push({
                          type: "thinking_delta",
                          contentIndex: thinkingBlockIndex,
                          delta: reasoningChunk,
                          partial: output,
                        });
                      }
                    }

                    // 2. Text content
                    if (delta.content) {
                      // End API thinking block if active
                      if (thinkingBlockIndex !== -1) {
                        const block = output.content[thinkingBlockIndex] as ThinkingContent;
                        stream.push({
                          type: "thinking_end",
                          contentIndex: thinkingBlockIndex,
                          content: block.thinking,
                          partial: output,
                        });
                        thinkingBlockIndex = -1;
                      }

                      if (thinkingParser) {
                        thinkingParser.processChunk(delta.content);
                      } else {
                        if (contentBlockIndex === -1) {
                          contentBlockIndex = output.content.length;
                          output.content.push({ type: "text", text: "" });
                          stream.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                        }
                        const block = output.content[contentBlockIndex] as TextContent;
                        block.text += delta.content;
                        stream.push({
                          type: "text_delta",
                          contentIndex: contentBlockIndex,
                          delta: delta.content,
                          partial: output,
                        });
                      }
                    }

                    // 3. Tool calls
                    if (Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        if (!isRecord(tc)) throw new Error("Qoder SSE payload has an invalid tool call");
                        const rawIndex = tc.index;
                        let idx = 0;
                        if (rawIndex !== undefined) {
                          if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0) {
                            throw new Error("Qoder SSE payload has an invalid tool call index");
                          }
                          idx = rawIndex;
                        }
                        if (idx >= MAX_TOOL_CALLS) {
                          throw new Error(`Qoder stream returned more than ${MAX_TOOL_CALLS} tool calls`);
                        }
                        if (!toolCallsState[idx]) {
                          toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
                        }
                        const state = toolCallsState[idx];
                        if (tc.id !== undefined && typeof tc.id !== "string") {
                          throw new Error("Qoder SSE payload has an invalid tool call id");
                        }
                        if (tc.id) state.id = tc.id;
                        if (tc.function !== undefined && !isRecord(tc.function)) {
                          throw new Error("Qoder SSE payload has an invalid tool function");
                        }
                        if (tc.function?.name !== undefined && typeof tc.function.name !== "string") {
                          throw new Error("Qoder SSE payload has an invalid tool name");
                        }
                        if (tc.function?.name) state.name = tc.function.name;

                        // Open the block as soon as the call is IDENTIFIABLE, not when
                        // its first argument byte arrives. A no-argument tool used to
                        // create no content block, making the finalizer claim "toolUse"
                        // on a message carrying no tool call, dead-ending the turn.
                        if (state.emittedStart === undefined && (state.id || state.name)) {
                          state.emittedStart = true;
                          state.contentIndex = output.content.length;
                          output.content.push({
                            type: "toolCall",
                            id: state.id,
                            name: state.name,
                            arguments: {},
                          } satisfies ToolCall);
                          stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                          if (state.arguments) {
                            stream.push({
                              type: "toolcall_delta",
                              contentIndex: state.contentIndex,
                              delta: state.arguments,
                              partial: output,
                            });
                          }
                        }

                        // id/name can arrive after the block is open; keep it in step.
                        if (state.emittedStart) {
                          const block = output.content[state.contentIndex] as ToolCall;
                          block.id = state.id;
                          block.name = state.name;
                        }

                        if (tc.function?.arguments !== undefined && typeof tc.function.arguments !== "string") {
                          throw new Error("Qoder SSE payload has non-string tool arguments");
                        }
                        if (tc.function?.arguments) {
                          const argDelta = tc.function.arguments;
                          if (state.arguments.length + argDelta.length > MAX_TOOL_ARGUMENT_CHARS) {
                            throw new Error(`Qoder tool arguments exceeded ${MAX_TOOL_ARGUMENT_CHARS} characters`);
                          }
                          state.arguments += argDelta;
                          if (state.emittedStart) {
                            stream.push({
                              type: "toolcall_delta",
                              contentIndex: state.contentIndex,
                              delta: argDelta,
                              partial: output,
                            });
                          }
                        }
                      }
                    }
                  }

                  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
                    if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) {
                      throw new Error("Qoder SSE payload has an invalid finish reason");
                    }
                    finishReasonSeen = true;
                    switch (choice.finish_reason) {
                      case "stop":
                        output.stopReason = "stop";
                        break;
                      case "length":
                        output.stopReason = "length";
                        break;
                      case "tool_calls":
                      case "function_call":
                        output.stopReason = "toolUse";
                        break;
                      case "error":
                        throw new Error("Qoder stream returned an error finish reason");
                      default:
                        throw new Error("Qoder stream returned an unsupported finish reason");
                    }
                  }
                }
              } catch (e) {
                // A malformed line means the transport no longer gives us a
                // trustworthy assistant message. Fail the stream so pi can
                // apply its bounded retry policy instead of treating truncation
                // as a successful response.
                if (e instanceof SyntaxError) {
                  throw new Error("Qoder stream ended before a terminal response event (malformed SSE JSON)");
                }
                throw e;
              }
            }

            if (protocolDone || finishReasonSeen) {
              // Qoder may keep the HTTP/SSE connection alive after its protocol-level
              // completion marker. Stop consuming immediately instead of waiting for
              // the transport EOF, which can leave pi stuck in the active turn.
              void reader.cancel().catch(() => {});
              innerController.abort();
              break;
            }

            if (transportDone) {
              throw new Error("Qoder stream ended before a terminal response event");
            }
          }

          if (thinkingParser) thinkingParser.finalize();

          if (thinkingBlockIndex !== -1) {
            const block = output.content[thinkingBlockIndex] as ThinkingContent;
            stream.push({
              type: "thinking_end",
              contentIndex: thinkingBlockIndex,
              content: block.thinking,
              partial: output,
            });
          }

          for (const state of toolCallsState) {
            if (state?.emittedStart && !state.emittedEnd) {
              state.emittedEnd = true;
              let args: Record<string, unknown> = {};
              const rawArguments = state.arguments.trim();
              if (rawArguments) {
                const parsedArguments: unknown = JSON.parse(rawArguments);
                if (!isRecord(parsedArguments)) {
                  throw new Error("Qoder stream returned non-object tool arguments");
                }
                args = parsedArguments;
              }
              const block = output.content[state.contentIndex] as ToolCall;
              block.arguments = args;
              stream.push({
                type: "toolcall_end",
                contentIndex: state.contentIndex,
                toolCall: {
                  type: "toolCall",
                  id: state.id,
                  name: state.name,
                  arguments: args,
                },
                partial: output,
              });
            }
          }

          const hasToolCalls = toolCallsState.some((state) => state?.emittedStart);
          if (toolCallsState.some((state) => state && !state.emittedStart && state.arguments.length > 0)) {
            throw new Error("Qoder stream returned tool arguments without a tool call identity");
          }
          if (output.stopReason === "toolUse" && !hasToolCalls) {
            throw new Error("Qoder stream returned tool_calls finish reason without a tool call");
          }
          // Guard on blocks that actually reached the message, not on the state array.
          if (hasToolCalls) {
            output.stopReason = "toolUse";
          }

          stream.push({
            type: "done",
            reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
            message: output,
          });
          stream.end();
        } catch (error) {
          if (streamTimedOut) {
            throw new Error("Qoder stream timeout: no terminal response was received");
          }
          throw error;
        } finally {
          if (streamTimeoutTimer !== undefined) clearTimeout(streamTimeoutTimer);
          // Always release the response body, including parse/upstream errors and
          // queue retries, so a half-closed proxy connection cannot leak.
          void reader?.cancel().catch(() => {});
          innerController.abort();
          options?.signal?.removeEventListener("abort", onExternalAbort);
        }
      };

      // Retry loop: on a QoderQueueError, surface a live notice, wait the
      // server-suggested duration, then re-issue the request.
      let attemptCount = 0;
      while (true) {
        attemptCount += 1;
        try {
          await attemptOnce();
          break;
        } catch (e) {
          if (!(e instanceof QoderQueueError)) throw e;
          // Only retry when nothing real has been produced yet — a queue error
          // arriving after content started would duplicate the reply.
          const realContentCount = queueNoticeIndex === null ? output.content.length : output.content.length - 1;
          if (realContentCount > 0 || attemptCount > queueRetryMax) throw e;

          const waitSec = e.queue.retryAfterSeconds ?? 30;
          const modelLabel = e.modelName || e.queue.modelKey || "当前模型";
          const queuePart =
            typeof e.queue.queueCount === "number" && e.queue.queueCount > 0
              ? `（队列约 ${e.queue.queueCount} 个请求）`
              : "";
          const line = `⏳ ${modelLabel} 排队中${queuePart}，预计等待约 ${waitSec} 秒，正在自动重试（第 ${attemptCount}/${queueRetryMax} 次）…`;
          if (queueNoticeIndex === null) {
            queueNoticeIndex = output.content.length;
            output.content.push({ type: "text", text: line });
            stream.push({ type: "text_start", contentIndex: queueNoticeIndex, partial: output });
          } else {
            const block = output.content[queueNoticeIndex] as TextContent;
            block.text += `\n${line}`;
            stream.push({ type: "text_delta", contentIndex: queueNoticeIndex, delta: `\n${line}`, partial: output });
          }
          await delayWithAbort(waitSec * 1000, options?.signal);
        }
      }
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}
