import crypto from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
// Imported from the subpath instead of the package entry: the entry pulls in the
// whole model catalog (~1.6MB, ~200ms at extension load), while this util is 3KB
// and defines the same class the entry re-exports.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  buildAuthHeaders,
  createQoderQueueError,
  formatQoderHttpError,
  formatQoderUpstreamError,
  getQoderChatURL,
  logCosyRequest,
  logCosyResponse,
  QoderQueueError,
} from "./cosy.js";
import { isQoderDebugEnabled, logDebug } from "./debug-log.js";
import { type DsmlToolCall, DsmlToolParser } from "./dsml.js";
import { withQoderHttpTimeout } from "./http.js";
import { prepareQoderRequest } from "./prepare.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { fitQoderImagesToBudget } from "./request-budget.js";
import { describeQoderMessages, describeQoderText } from "./request-diagnostics.js";
import { ThinkingTagParser, ThinkingTagStripper } from "./thinking-parser.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  error?: string;
}

function logStreamDebug(event: string, details: Record<string, unknown>): void {
  if (isQoderDebugEnabled()) logDebug("stream", { event, ...details });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error, message: String(error) };
  const value = error as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    cause?: unknown;
  };
  const details: Record<string, unknown> = {
    name: value.name,
    message: value.message,
    code: value.code,
    errno: value.errno,
    syscall: value.syscall,
  };
  if (value.cause instanceof Error) {
    const cause = value.cause as Error & { code?: unknown; errno?: unknown; syscall?: unknown };
    details.cause = {
      name: cause.name,
      message: cause.message,
      code: cause.code,
      errno: cause.errno,
      syscall: cause.syscall,
    };
  } else if (value.cause !== undefined) {
    details.cause = String(value.cause);
  }
  return details;
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
const MALFORMED_TOOL_RETRY_PROMPT = "Your tool call was malformed and could not be parsed. Please retry.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function cloneUsage(usage: AssistantMessage["usage"]): AssistantMessage["usage"] {
  return { ...usage, cost: { ...usage.cost } };
}

function addUsage(target: AssistantMessage["usage"], source: AssistantMessage["usage"]): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost.input += source.cost.input;
  target.cost.output += source.cost.output;
  target.cost.cacheRead += source.cost.cacheRead;
  target.cost.cacheWrite += source.cost.cacheWrite;
  target.cost.total += source.cost.total;
}

export function streamQoder(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

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
    let previousMalformedUsage: AssistantMessage["usage"] | undefined;
    let previousMalformedUsageMerged = false;
    const mergePreviousMalformedUsage = () => {
      if (previousMalformedUsage && !previousMalformedUsageMerged) {
        addUsage(output.usage, previousMalformedUsage);
        previousMalformedUsageMerged = true;
      }
    };

    try {
      // Prelude: identity, quota, model key, replayed messages, tools and
      // generation parameters.
      const prepared = await prepareQoderRequest(model, context, options);
      const {
        providerMode,
        accessToken,
        userID,
        name,
        email,
        machineID,
        qoderModel,
        modelConfig,
        isReasoning,
        systemText,
        normalizedMessages,
        lastUserText,
        sessionID,
        maxTokens,
        reasoningEffort,
        enableThinking,
        contextWindow,
        toolsRaw,
      } = prepared;

      // Context window: pi's streamSimple has no contextWindow option, so honor
      // the user's Qoder CLI preference from ~/.qoder/settings.json
      // (model.contextWindow or model.preferences.<qoderModel>.contextWindow).
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      // Queue-aware auto retry: when the upstream answers with a 10605 "model
      // queued" payload, surface a live notice, wait the server-suggested
      // duration, then re-issue the same request (fresh request_id, same
      // session) instead of failing the turn. If the queue never clears, the
      // original friendly QoderQueueError message surfaces to the user.
      const queueRetryMax = parseQueueRetryMax();
      let queueNoticeIndex: number | null = null;
      const imageNoticeIndexes = new Set<number>();
      let requestMessages = normalizedMessages;
      let requestLastUserText = lastUserText;
      let malformedRetryCount = 0;
      let queueAttemptCount = 0;

      stream.push({ type: "start", partial: output });

      const attemptOnce = async (): Promise<{
        malformed: boolean;
        malformedText: string;
        failedToolCalls: ToolCallState[];
      }> => {
        output.stopReason = "stop";
        delete output.errorMessage;
        // Inner AbortController so both the caller's signal and an idle timeout
        // (hung upstream, e.g. quota exhausted) can tear the fetch down.
        const attemptStartedAt = Date.now();
        const innerController = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let requestId = "";
        let readCount = 0;
        let totalReadBytes = 0;
        let sseEventCount = 0;
        let lastReadAt = attemptStartedAt;
        const onExternalAbort = () => {
          logStreamDebug("external-abort", {
            requestId,
            elapsedMs: Date.now() - attemptStartedAt,
            readCount,
            totalReadBytes,
            sseEventCount,
          });
          innerController.abort();
          void reader?.cancel().catch(() => {});
        };
        let streamTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let streamTimedOut = false;
        options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
        try {
          if (options?.signal?.aborted) throw new Error("aborted");
          requestId = crypto.randomUUID();
          const reqBody = {
            request_id: requestId,
            request_set_id: recordID,
            chat_record_id: recordID,
            session_id: sessionID,
            stream: true,
            chat_task: "FREE_INPUT",
            is_reply: true,
            is_retry: malformedRetryCount > 0,
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
              ? [{ role: "system" as const, content: systemText }, ...requestMessages]
              : requestMessages,
            tools: toolsRaw || [],
            parameters: {
              max_tokens: maxTokens,
              reasoning_effort: reasoningEffort,
              enable_thinking: enableThinking,
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
                originalContent: requestLastUserText,
              },
              features: [],
              text: requestLastUserText,
            },
            model_config: modelConfig,
            business: {
              product: "cli",
              version: "1.0.0",
              type: "agent",
              stage: "start",
              id: crypto.randomUUID(),
              name: requestLastUserText.substring(0, 30),
              begin_at: Date.now(),
            },
          };

          if (options?.signal?.aborted) throw new Error("aborted");
          const { bodyBytes, messages, omittedImages } = fitQoderImagesToBudget(reqBody, MAX_REQUEST_BODY_BYTES);
          // Reuse the fitted history on queue/malformed retries instead of restoring old images.
          requestMessages = systemText ? messages.slice(1) : messages;
          if (omittedImages > 0) {
            const contentIndex = output.content.length;
            const notice = `⚠️ 请求体过大，本次请求已省略 ${omittedImages} 张较旧图片，保留文本和最新图片。建议 /compact。\n\n`;
            imageNoticeIndexes.add(contentIndex);
            output.content.push({ type: "text", text: notice });
            stream.push({ type: "text_start", contentIndex, partial: output });
            stream.push({ type: "text_delta", contentIndex, delta: notice, partial: output });
            stream.push({ type: "text_end", contentIndex, content: notice, partial: output });
          }
          if (isQoderDebugEnabled()) {
            logDebug("request-snapshot", {
              requestId,
              isRetry: malformedRetryCount > 0,
              model: qoderModel,
              parameters: reqBody.parameters,
              messages: describeQoderMessages(messages),
            });
          }
          const encodedBody = qoderEncodeBody(bodyBytes);
          const encodedBytes = Buffer.from(encodedBody, "utf8");

          logStreamDebug("request", {
            requestId,
            sessionId: sessionID,
            model: qoderModel,
            bodyBytes: bodyBytes.byteLength,
            omittedImages,
            encodedBytes: encodedBytes.byteLength,
            messageCount: messages.length,
            toolCount: Array.isArray(reqBody.tools) ? reqBody.tools.length : 0,
          });

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
          logStreamDebug("response", {
            requestId,
            status: response.status,
            statusText: response.statusText,
            elapsedMs: Date.now() - attemptStartedAt,
          });

          if (!response.ok) {
            const errText = await withQoderHttpTimeout("chat error body", innerController.signal, () =>
              response.text(),
            );
            throw new Error(formatQoderHttpError("api", response.status, response.statusText, errText, chatURL));
          }

          reader = response.body?.getReader();
          if (!reader) throw new Error("No response body");
          logStreamDebug("reader-open", {
            requestId,
            elapsedMs: Date.now() - attemptStartedAt,
            contentType: response.headers.get("content-type"),
          });
          const streamTimeoutMs = parseStreamTimeout();
          if (streamTimeoutMs > 0) {
            streamTimeoutTimer = setTimeout(() => {
              streamTimedOut = true;
              logStreamDebug("stream-timeout", {
                requestId,
                timeoutMs: streamTimeoutMs,
                elapsedMs: Date.now() - attemptStartedAt,
                readCount,
                totalReadBytes,
                sseEventCount,
              });
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

          let thinkingBlockIndex = -1;
          const toolCallsState: ToolCallState[] = [];
          const dsmlToolCalls: ToolCall[] = [];
          // Upstream can still send inline thinking when thinking is disabled.
          const thinkingParser = new ThinkingTagParser(output, stream);
          const reasoningTagStripper = new ThinkingTagStripper();

          const endApiThinking = () => {
            if (thinkingBlockIndex === -1) return;
            const block = output.content[thinkingBlockIndex] as ThinkingContent;
            stream.push({
              type: "thinking_end",
              contentIndex: thinkingBlockIndex,
              content: block.thinking,
              partial: output,
            });
            thinkingBlockIndex = -1;
          };

          const appendText = (text: string) => {
            if (!text) return;
            endApiThinking();
            thinkingParser.processChunk(text);
          };

          const appendThinking = (text: string) => {
            if (!text) return;
            if (thinkingBlockIndex === -1) {
              thinkingBlockIndex = output.content.length;
              output.content.push({ type: "thinking", thinking: "" });
              stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
            }
            const block = output.content[thinkingBlockIndex] as ThinkingContent;
            block.thinking += text;
            stream.push({
              type: "thinking_delta",
              contentIndex: thinkingBlockIndex,
              delta: text,
              partial: output,
            });
          };

          const emitDsmlTool = ({ name, arguments: args }: DsmlToolCall) => {
            logStreamDebug("dsml-tool-call", {
              requestId,
              name,
              argumentChars: JSON.stringify(args).length,
            });
            if (dsmlToolCalls.length + toolCallsState.filter(Boolean).length >= MAX_TOOL_CALLS) {
              throw new Error(`Qoder stream returned more than ${MAX_TOOL_CALLS} tool calls`);
            }
            dsmlToolCalls.push({
              type: "toolCall",
              id: `dsml-${requestId}-${dsmlToolCalls.length}`,
              name,
              arguments: args as ToolCall["arguments"],
            });
          };

          const malformedDsml: string[] = [];
          const dsmlParser = new DsmlToolParser(appendText, emitDsmlTool, {
            onMalformedInvocation: (raw) => malformedDsml.push(raw),
          });
          // The reasoning channel only ever carries *degenerate* DSML (the
          // opener got stripped upstream); a complete `<invoke>` draft there is
          // just the model thinking out loud and must stay thinking text.
          const dsmlReasoningParser = new DsmlToolParser(appendThinking, emitDsmlTool, {
            incompleteOnly: true,
            onMalformedInvocation: (raw) => malformedDsml.push(raw),
          });

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
                  logStreamDebug("idle-timeout", {
                    requestId,
                    timeoutMs: idleTimeoutMs,
                    elapsedMs: Date.now() - attemptStartedAt,
                    readCount,
                    totalReadBytes,
                    sseEventCount,
                    lastReadAgeMs: Date.now() - lastReadAt,
                  });
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
            const readAt = Date.now();
            const transportDone = done === true;
            const readBytes = value?.byteLength ?? 0;
            readCount += 1;
            if (readBytes > 0) {
              const gapMs = readAt - lastReadAt;
              lastReadAt = readAt;
              totalReadBytes += readBytes;
              logStreamDebug("read", {
                requestId,
                readCount,
                bytes: readBytes,
                totalReadBytes,
                gapMs,
                transportDone,
                elapsedMs: readAt - attemptStartedAt,
              });
              lastDataAt = readAt;
              buffer += decoder.decode(value!, { stream: !transportDone });
              if (buffer.length > MAX_SSE_BUFFER_CHARS) {
                throw new Error(`Qoder SSE event exceeded ${MAX_SSE_BUFFER_CHARS} characters`);
              }
            } else if (!transportDone) {
              if (readCount === 1 || readCount % 100 === 0) {
                logStreamDebug("read-empty", {
                  requestId,
                  readCount,
                  totalReadBytes,
                  elapsedMs: readAt - attemptStartedAt,
                });
              }
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
                logStreamDebug("terminal", {
                  requestId,
                  reason: "raw-done",
                  elapsedMs: Date.now() - attemptStartedAt,
                  readCount,
                  totalReadBytes,
                  sseEventCount,
                });
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
                sseEventCount += 1;
                if (status !== 200) {
                  if (typeof envelope.body !== "string") throw new Error("Qoder SSE error envelope has no body");
                  if (isQoderDebugEnabled()) {
                    logDebug("stream-error", {
                      requestId,
                      eventNo: sseEventCount,
                      status,
                      body: envelope.body.slice(0, 500),
                      sentMessages: describeQoderMessages(messages),
                    });
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
                  logStreamDebug("terminal", {
                    requestId,
                    reason: "envelope-done",
                    eventNo: sseEventCount,
                    elapsedMs: Date.now() - attemptStartedAt,
                    readCount,
                    totalReadBytes,
                  });
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
                const firstChoice =
                  Array.isArray(inner.choices) && isRecord(inner.choices[0]) ? inner.choices[0] : undefined;
                const firstDelta = firstChoice && isRecord(firstChoice.delta) ? firstChoice.delta : undefined;
                logStreamDebug("event", {
                  requestId,
                  eventNo: sseEventCount,
                  bodyChars: innerStr.length,
                  responseId: typeof inner.id === "string" ? inner.id : undefined,
                  model: typeof inner.model === "string" ? inner.model : undefined,
                  choiceCount: Array.isArray(inner.choices) ? inner.choices.length : 0,
                  finishReason: firstChoice?.finish_reason,
                  contentChars: typeof firstDelta?.content === "string" ? firstDelta.content.length : 0,
                  reasoningChars:
                    typeof firstDelta?.reasoning_content === "string" ? firstDelta.reasoning_content.length : 0,
                  toolCallCount: Array.isArray(firstDelta?.tool_calls) ? firstDelta.tool_calls.length : 0,
                  elapsedMs: Date.now() - attemptStartedAt,
                });
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
                      if (
                        isQoderDebugEnabled() &&
                        /<invoke|<parameter|<calls>|&lt;|\uFF5C|tool▁/i.test(delta.reasoning_content)
                      ) {
                        logStreamDebug("dsml-raw-reasoning", {
                          requestId,
                          eventNo: sseEventCount,
                          content: describeQoderText(delta.reasoning_content),
                        });
                      }
                      const reasoningChunk = reasoningTagStripper.push(delta.reasoning_content);
                      if (reasoningChunk) dsmlReasoningParser.push(reasoningChunk);
                    }

                    // 2. Text content and Qoder's XML/DSML tool-call fallback
                    if (delta.content) {
                      if (
                        isQoderDebugEnabled() &&
                        /<invoke|<parameter|<calls>|&lt;|\uFF5C|tool▁/i.test(delta.content)
                      ) {
                        logStreamDebug("dsml-raw", {
                          requestId,
                          eventNo: sseEventCount,
                          content: describeQoderText(delta.content),
                        });
                      }
                      dsmlParser.push(delta.content);
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
                          if (toolCallsState.filter(Boolean).length + dsmlToolCalls.length >= MAX_TOOL_CALLS) {
                            throw new Error(`Qoder stream returned more than ${MAX_TOOL_CALLS} tool calls`);
                          }
                          toolCallsState[idx] = { arguments: "", id: "", name: "" };
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

                        if (tc.function?.arguments !== undefined && typeof tc.function.arguments !== "string") {
                          throw new Error("Qoder SSE payload has non-string tool arguments");
                        }
                        if (tc.function?.arguments) {
                          const argDelta = tc.function.arguments;
                          if (state.arguments.length + argDelta.length > MAX_TOOL_ARGUMENT_CHARS) {
                            throw new Error(`Qoder tool arguments exceeded ${MAX_TOOL_ARGUMENT_CHARS} characters`);
                          }
                          state.arguments += argDelta;
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
              logStreamDebug("terminal", {
                requestId,
                reason: protocolDone ? "protocol-done" : "finish-reason",
                elapsedMs: Date.now() - attemptStartedAt,
                readCount,
                totalReadBytes,
                sseEventCount,
              });
              void reader.cancel().catch(() => {});
              innerController.abort();
              break;
            }

            if (transportDone) {
              logStreamDebug("transport-end-without-terminal", {
                requestId,
                elapsedMs: Date.now() - attemptStartedAt,
                readCount,
                totalReadBytes,
                sseEventCount,
                bufferedChars: buffer.length,
              });
              throw new Error("Qoder stream ended before a terminal response event");
            }
          }

          dsmlReasoningParser.push(reasoningTagStripper.finish());
          dsmlParser.finish();
          dsmlReasoningParser.finish();
          endApiThinking();
          thinkingParser.finalize();

          const nativeCalls: ToolCall[] = [];
          const invalidNativeCalls: ToolCallState[] = [];
          const unidentifiedToolArguments: string[] = [];
          for (const [index, state] of toolCallsState.entries()) {
            if (!state) continue;
            if (!state.name) {
              if (state.id || state.arguments) unidentifiedToolArguments.push(JSON.stringify(state));
              continue;
            }
            state.id ||= `call-${requestId}-${index}`;
            try {
              const parsed: unknown = state.arguments.trim() ? JSON.parse(state.arguments) : {};
              if (!isRecord(parsed)) throw new Error("Tool arguments must be a JSON object");
              state.arguments = JSON.stringify(parsed);
              nativeCalls.push({
                type: "toolCall",
                id: state.id,
                name: state.name,
                arguments: parsed as ToolCall["arguments"],
              });
            } catch (error) {
              state.error = describeError(error);
              invalidNativeCalls.push(state);
            }
          }

          const calls = [...dsmlToolCalls, ...nativeCalls];
          const malformed =
            invalidNativeCalls.length > 0 ||
            malformedDsml.length > 0 ||
            unidentifiedToolArguments.length > 0 ||
            (calls.length === 0 && output.stopReason === "toolUse");
          const malformedText = [...malformedDsml, ...unidentifiedToolArguments].join("\n");
          // Do not emit any executable tool block until the entire batch validates.
          // A malformed sibling must not execute valid calls twice after a retry.
          if (!malformed) {
            if (calls.length > MAX_TOOL_CALLS) {
              throw new Error(`Qoder stream returned more than ${MAX_TOOL_CALLS} tool calls`);
            }
            for (const call of calls) {
              const contentIndex = output.content.length;
              output.content.push(call);
              stream.push({ type: "toolcall_start", contentIndex, partial: output });
              const args = JSON.stringify(call.arguments);
              if (args !== "{}") stream.push({ type: "toolcall_delta", contentIndex, delta: args, partial: output });
              stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
            }
            if (calls.length > 0) output.stopReason = "toolUse";
          }

          if (isQoderDebugEnabled()) {
            const text = output.content
              .filter((block): block is TextContent => block.type === "text")
              .map((block) => block.text)
              .join("");
            const diagnostic = describeQoderText(text);
            if (diagnostic.tags.summary || diagnostic.tags.analysis) {
              logDebug("summary-response", { requestId, reason: output.stopReason, ...diagnostic });
            }
          }
          logStreamDebug("attempt-complete", {
            requestId,
            reason: output.stopReason,
            malformed,
            malformedChars: malformedText.length,
            elapsedMs: Date.now() - attemptStartedAt,
            readCount,
            totalReadBytes,
            sseEventCount,
            contentBlocks: output.content.length,
            usage: output.usage,
          });
          return {
            malformed,
            malformedText,
            failedToolCalls: malformed
              ? [
                  ...toolCallsState.filter((state) => state?.name),
                  ...dsmlToolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  })),
                ]
              : [],
          };
        } catch (error) {
          logStreamDebug("attempt-error", {
            requestId,
            error: describeError(error),
            errorDetails: describeErrorDetails(error),
            streamTimedOut,
            elapsedMs: Date.now() - attemptStartedAt,
            readCount,
            totalReadBytes,
            sseEventCount,
          });
          if (streamTimedOut) {
            throw new Error("Qoder stream timeout: no terminal response was received");
          }
          throw error;
        } finally {
          logStreamDebug("attempt-finally", {
            requestId,
            elapsedMs: Date.now() - attemptStartedAt,
            readCount,
            totalReadBytes,
            sseEventCount,
            aborted: innerController.signal.aborted,
          });
          if (streamTimeoutTimer !== undefined) clearTimeout(streamTimeoutTimer);
          // Always release the response body, including parse/upstream errors and
          // queue retries, so a half-closed proxy connection cannot leak.
          void reader?.cancel().catch(() => {});
          innerController.abort();
          options?.signal?.removeEventListener("abort", onExternalAbort);
        }
      };

      // Retry malformed tool calls once with Qoder CLI's corrective user message.
      // Ordinary text stays streamed; only the malformed DSML fragment is withheld.
      while (true) {
        try {
          const result = await attemptOnce();
          if (result.malformed) {
            if (!toolsRaw?.length) {
              throw new Error(
                output.stopReason === "toolUse" && result.failedToolCalls.length === 0 && !result.malformedText
                  ? "Qoder stream returned tool_calls finish reason without a tool call"
                  : "Qoder returned an unparseable tool call without a tool call retry capability",
              );
            }
            if (malformedRetryCount >= 1) {
              throw new Error("Qoder returned an unparseable tool call after one retry");
            }

            const responseBlocks = output.content.filter(
              (_, index) => !imageNoticeIndexes.has(index) && index !== queueNoticeIndex,
            );
            const assistantText = responseBlocks
              .filter((block): block is TextContent => block.type === "text")
              .map((block) => block.text)
              .join("");
            const assistantReasoning = responseBlocks
              .filter((block): block is ThinkingContent => block.type === "thinking")
              .map((block) => block.thinking)
              .join("");
            const malformedResponse = assistantText + result.malformedText;
            requestMessages = [...requestMessages];
            if (malformedResponse || assistantReasoning || result.failedToolCalls.length > 0) {
              requestMessages.push({
                role: "assistant",
                content: malformedResponse || " ",
                ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
                ...(result.failedToolCalls.length > 0
                  ? {
                      tool_calls: result.failedToolCalls.map((state) => ({
                        id: state.id,
                        type: "function" as const,
                        function: { name: state.name, arguments: state.arguments },
                      })),
                    }
                  : {}),
              });
            }
            // Exactly one feedback message per abandoned call; none was executed.
            for (const state of result.failedToolCalls) {
              requestMessages.push({
                role: "tool",
                tool_call_id: state.id,
                content: state.error
                  ? "Tool call was not executed: arguments are not a valid JSON object. Please correct the arguments."
                  : "Tool call was not executed because another call in the same response was malformed. Please retry.",
              });
            }
            requestMessages.push({ role: "user", content: MALFORMED_TOOL_RETRY_PROMPT });
            requestLastUserText = MALFORMED_TOOL_RETRY_PROMPT;
            malformedRetryCount += 1;

            previousMalformedUsage = cloneUsage(output.usage);
            previousMalformedUsageMerged = false;
            output.usage = emptyUsage();
            output.responseId = undefined;
            output.responseModel = undefined;
            logStreamDebug("malformed-tool-retry", {
              retry: malformedRetryCount,
              malformedChars: result.malformedText.length,
              responseChars: malformedResponse.length,
            });
            continue;
          }

          mergePreviousMalformedUsage();
          stream.push({
            type: "done",
            reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
            message: output,
          });
          stream.end();
          break;
        } catch (e) {
          if (!(e instanceof QoderQueueError)) throw e;
          queueAttemptCount += 1;
          // Only retry when nothing real has been produced yet — a queue error
          // arriving after content started would duplicate the reply.
          const realContentCount =
            output.content.length - imageNoticeIndexes.size - (queueNoticeIndex === null ? 0 : 1);
          if (realContentCount > 0 || queueAttemptCount > queueRetryMax) throw e;

          const waitSec = e.queue.retryAfterSeconds ?? 30;
          const modelLabel = e.modelName || e.queue.modelKey || "当前模型";
          const queuePart =
            typeof e.queue.queueCount === "number" && e.queue.queueCount > 0
              ? `（队列约 ${e.queue.queueCount} 个请求）`
              : "";
          const line = `⏳ ${modelLabel} 排队中${queuePart}，预计等待约 ${waitSec} 秒，正在自动重试（第 ${queueAttemptCount}/${queueRetryMax} 次）…`;
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
      mergePreviousMalformedUsage();
      logStreamDebug("turn-error", {
        error: describeError(e),
        errorDetails: describeErrorDetails(e),
        aborted: options?.signal?.aborted ?? false,
        contentBlocks: output.content.length,
      });
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
