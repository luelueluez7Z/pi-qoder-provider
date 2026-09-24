import crypto from "node:crypto";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { isQoderCNMode } from "./cosy.js";
import { isQoderDebugEnabled, logDebug } from "./debug-log.js";
import { withQoderHttpTimeout } from "./http.js";
import type { PreparedQoderRequest } from "./prepare.js";

// ---------------------------------------------------------------------------
// qodercli's "model server" protocol (v2).
//
// The current Qoder CLI talks to a plain OpenAI-compatible endpoint:
//   POST https://<model-server-host>/model/v1/chat/completions
//   Authorization: Bearer <security_oauth_token>
// Response is a standard `data: {...}` SSE stream (chat.completion.chunk) with
// native tool_calls / reasoning_content and a `data: [DONE]` terminator.
//
// Compared with the legacy COSY gateway this drops request signing, body
// obfuscation, the `{statusCodeValue, body}` envelope and XML/DSML tool-call
// parsing entirely.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_SERVER_HOST = "api2-v2.qoder.sh";

/** Client type qodercli reports in metadata.context (matches the COSY client type). */
const CLIENT_TYPE = "5";

const MAX_TOOL_CALLS = 128;
const MAX_TOOL_ARGUMENT_CHARS = 1 * 1024 * 1024;
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

export type QoderProtocol = "auto" | "v2" | "legacy";

function parseProtocolMode(raw: string | undefined): QoderProtocol | undefined {
  const value = (raw || "").trim().toLowerCase();
  if (!value) return undefined;
  if (["v2", "new", "model-server", "modelserver"].includes(value)) return "v2";
  if (["legacy", "v1", "old", "sse", "cosy"].includes(value)) return "legacy";
  if (value === "auto") return "auto";
  return undefined;
}

/** Selected transport: QODER_PROTOCOL = auto (default) | v2 | legacy. */
export function getQoderProtocol(): QoderProtocol {
  return parseProtocolMode(process.env.QODER_PROTOCOL) ?? "auto";
}

/** Model server host: QODER_MODEL_SERVER_HOST overrides qodercli's prod host. */
export function getQoderModelServerHost(): string {
  const override = process.env.QODER_MODEL_SERVER_HOST?.trim();
  if (!override) return DEFAULT_MODEL_SERVER_HOST;
  return override.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function getQoderModelServerChatURL(): string {
  return `https://${getQoderModelServerHost()}/model/v1/chat/completions`;
}

/**
 * Whether this turn should use the model server.
 *  - legacy: never
 *  - v2: always (even for CN / VPC hosts, so an explicit override always wins)
 *  - auto: everything except CN mode, whose gateway has no /model/v1 route at all
 *
 * `auto` deliberately does NOT keep a local list of "legacy-only" models: the
 * wire support is decided by the server, and a model the model server does not
 * serve yet fails loudly (invalid_model_error) instead of silently falling back
 * to the COSY gateway.
 */
export function useQoderModelServer(providerMode: string): boolean {
  const protocol = getQoderProtocol();
  if (protocol === "legacy") return false;
  if (protocol === "v2") return true;
  return !isQoderCNMode(providerMode);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logModelServer(event: string, details: Record<string, unknown>): void {
  if (isQoderDebugEnabled()) logDebug("model-server", { event, ...details });
}

/**
 * Business identity sent in metadata.business.
 *
 * The model server resolves a model key against the registry of the business
 * product it is called for: without this block the catalog keys that only the
 * CLI product knows (`dfmodel`, `qmodel_38max`, `gfmodel`, `cmodel`, …) come
 * back as `invalid_model_error`. qodercli always sends `business.product` (its
 * client identity) plus the business type; these are the same defaults its
 * bundle falls back to (product "cli", type "agent").
 */
const BUSINESS_PRODUCT = "cli";
const BUSINESS_TYPE = "agent";

/** Build the OpenAI-shaped request body for the model server. */
export function buildModelServerBody(prepared: PreparedQoderRequest, requestId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: prepared.qoderModel,
    messages: prepared.systemText
      ? [{ role: "system", content: prepared.systemText }, ...prepared.normalizedMessages]
      : prepared.normalizedMessages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: prepared.maxTokens,
    metadata: {
      context: {
        request_id: requestId,
        session_id: prepared.sessionID,
        task_id: "common",
        client_type: CLIENT_TYPE,
      },
      business: { product: BUSINESS_PRODUCT, type: BUSINESS_TYPE },
    },
  };
  if (prepared.toolsRaw && prepared.toolsRaw.length > 0) body.tools = prepared.toolsRaw;
  // The model server honours the reasoning switch as `reasoning.effort`
  // (top-level reasoning_effort is ignored). "none" must be sent explicitly —
  // omitting it lets the upstream apply its own default.
  if (prepared.isReasoning) body.reasoning = { effort: prepared.reasoningEffort };
  if (prepared.contextWindow) body.parameters = { context_length: prepared.contextWindow };
  return body;
}

/** Model label for error messages: the catalog's display name, plus its wire key. */
function modelLabel(prepared: PreparedQoderRequest): string {
  const display = prepared.modelConfig.display_name;
  return display ? `${display}（${prepared.qoderModel}）` : prepared.qoderModel;
}

/** Friendly Chinese hint for a model-server business error. */
export function formatModelServerError(code: string, message: string, modelName?: string): string {
  const model = modelName || "当前模型";
  switch (code) {
    case "invalid_model_error":
      return (
        `模型 ${model} 尚未接入模型服务（${message}）。` + `请改用其他模型，或设置 QODER_PROTOCOL=legacy 走旧网关。`
      );
    case "provider_error":
      return `上游模型调用失败（${model}）：${message}`;
    case "auth_error":
    case "unauthorized":
      return "登录已过期，请重新登录后再试。";
    case "insufficient_credits":
    case "quota_exceeded":
      return `积分额度已用完，请升级套餐或充值后重试。（${message}）`;
    default:
      return code ? `Qoder 模型服务返回错误（${code}）：${message}` : `Qoder 模型服务返回错误：${message}`;
  }
}

/** Idle timeout (ms) before a silent stream is declared hung; 0 disables. */
function parseIdleTimeout(): number {
  const raw = process.env.QODER_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 60_000;
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `text` already contains one complete JSON value (object/array).
 *
 * The model server streams very long terminal chunks whose `raw_usage` block
 * contains real newlines, so a single payload can span several lines. Framing
 * the event by brace balance (instead of by line) keeps those chunks intact.
 */
export function isCompleteJson(text: string): boolean {
  const start = text.trimStart();
  if (!start.startsWith("{") && !start.startsWith("[")) return true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth <= 0) return true;
    }
  }
  return false;
}

/** Sleep for `ms`, rejecting early when `signal` aborts. */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ToolCallState {
  id: string;
  name: string;
  args: string;
  contentIndex: number;
  started: boolean;
  ended: boolean;
}

/**
 * Run one turn against the model server. Assumes pi's `start` event has already
 * been pushed; pushes the block events plus a terminal `done`, and throws on
 * failure so the caller's error handling reports it.
 */
export async function runModelServerTurn(args: {
  prepared: PreparedQoderRequest;
  options?: SimpleStreamOptions;
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
}): Promise<void> {
  const { prepared, options, output, stream } = args;
  const requestId = crypto.randomUUID();
  const chatURL = getQoderModelServerChatURL();
  const requestBody = buildModelServerBody(prepared, requestId);
  const bodyBytes = Buffer.from(JSON.stringify(requestBody));

  const innerController = new AbortController();
  const onExternalAbort = () => innerController.abort();
  options?.signal?.addEventListener("abort", onExternalAbort, { once: true });

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const startedAt = Date.now();
  try {
    if (options?.signal?.aborted) throw new Error("aborted");

    logModelServer("request", {
      requestId,
      url: chatURL,
      model: prepared.qoderModel,
      catalogKey: prepared.qoderModel,
      sessionId: prepared.sessionID,
      bodyBytes: bodyBytes.byteLength,
      messageCount: (requestBody.messages as unknown[]).length,
      toolCount: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
    });

    const response = await withQoderHttpTimeout("model server connection", innerController.signal, (signal) =>
      fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          Authorization: `Bearer ${prepared.accessToken}`,
          "X-Request-ID": requestId,
          "X-Session-ID": prepared.sessionID,
        },
        body: bodyBytes,
        signal,
      }),
    );

    if (!response.ok) {
      const errorText = await withQoderHttpTimeout("model server error body", innerController.signal, () =>
        response.text(),
      );
      if (response.status === 401 || response.status === 403) {
        throw new Error("Qoder 登录已过期，请重新登录后再试。");
      }
      throw new Error(
        `Qoder 模型服务请求失败：${response.status} ${response.statusText} ${errorText.slice(0, 200)}`.trim(),
      );
    }

    reader = response.body?.getReader();
    if (!reader) throw new Error("Qoder 模型服务没有返回响应体");

    logModelServer("response", {
      requestId,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      contentType: response.headers.get("content-type"),
    });

    // ---- Block bookkeeping -------------------------------------------------
    let textBlockIndex = -1;
    let thinkingBlockIndex = -1;
    const toolCalls: ToolCallState[] = [];

    const endThinking = () => {
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

    const appendThinking = (text: string) => {
      if (!text) return;
      if (thinkingBlockIndex === -1) {
        thinkingBlockIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
      }
      (output.content[thinkingBlockIndex] as ThinkingContent).thinking += text;
      stream.push({
        type: "thinking_delta",
        contentIndex: thinkingBlockIndex,
        delta: text,
        partial: output,
      });
    };

    const appendText = (text: string) => {
      if (!text) return;
      endThinking();
      if (textBlockIndex === -1) {
        textBlockIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
      }
      (output.content[textBlockIndex] as TextContent).text += text;
      stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: text, partial: output });
    };

    /** Open the block for a tool call index as soon as it is identifiable. */
    const ensureToolCall = (index: number, id: string, name: string): ToolCallState => {
      let state = toolCalls[index];
      if (!state) {
        if (index >= MAX_TOOL_CALLS) {
          throw new Error(`Qoder 模型服务返回了超过 ${MAX_TOOL_CALLS} 个工具调用`);
        }
        state = { id: id || `ms-${requestId}-${index}`, name, args: "", contentIndex: 0, started: false, ended: false };
        toolCalls[index] = state;
      }
      if (id) state.id = id;
      if (name) state.name = name;
      if (!state.started && (state.id || state.name)) {
        endThinking();
        state.started = true;
        state.contentIndex = output.content.length;
        output.content.push({
          type: "toolCall",
          id: state.id,
          name: state.name,
          arguments: {},
        } satisfies ToolCall);
        stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
        // Text after a tool call starts a new block so the order is preserved.
        textBlockIndex = -1;
      }
      return state;
    };

    const applyChunk = (chunk: Record<string, unknown>) => {
      if (typeof chunk.id === "string" && chunk.id) output.responseId = chunk.id;
      if (typeof chunk.model === "string" && chunk.model) output.responseModel = chunk.model;

      if (isRecord(chunk.usage)) {
        const u = chunk.usage as {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          credits?: number;
          prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
        };
        // pi's promptTokens = input + cacheRead + cacheWrite (Anthropic
        // convention), but OpenAI-style prompt_tokens already includes cached
        // tokens, so subtract them here.
        const promptTokens = u.prompt_tokens ?? 0;
        const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
        const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
        output.usage.input = Math.max(0, promptTokens - cacheRead - cacheWrite);
        output.usage.output = u.completion_tokens ?? 0;
        output.usage.totalTokens = u.total_tokens ?? 0;
        output.usage.cacheRead = cacheRead;
        output.usage.cacheWrite = cacheWrite;
        // The model server reports tokens only; when it does report credits
        // (legacy field) keep pi's session credit total accurate.
        const credits = typeof u.credits === "number" && u.credits > 0 ? u.credits : 0;
        if (credits > 0) {
          const billed = output.usage.input + output.usage.output + cacheRead + cacheWrite;
          const inputShare = output.usage.input + cacheRead + cacheWrite;
          if (billed > 0) {
            output.usage.cost.input = (credits * inputShare) / billed;
            output.usage.cost.output = (credits * output.usage.output) / billed;
          } else {
            output.usage.cost.input = credits;
          }
          output.usage.cost.total = credits;
        }
      }

      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) return;
      const choice = choices[0];
      if (!isRecord(choice)) return;

      const delta = choice.delta;
      if (isRecord(delta)) {
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          appendThinking(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          appendText(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            if (!isRecord(raw)) continue;
            const index = typeof raw.index === "number" && raw.index >= 0 ? raw.index : 0;
            const fn = isRecord(raw.function) ? raw.function : {};
            const state = ensureToolCall(
              index,
              typeof raw.id === "string" ? raw.id : "",
              typeof fn.name === "string" ? fn.name : "",
            );
            if (state.started) {
              const block = output.content[state.contentIndex] as ToolCall;
              block.id = state.id;
              block.name = state.name;
            }
            if (typeof fn.arguments === "string" && fn.arguments) {
              if (state.args.length + fn.arguments.length > MAX_TOOL_ARGUMENT_CHARS) {
                throw new Error(`Qoder 工具参数超过 ${MAX_TOOL_ARGUMENT_CHARS} 个字符`);
              }
              state.args += fn.arguments;
              if (state.started) {
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: state.contentIndex,
                  delta: fn.arguments,
                  partial: output,
                });
              }
            }
          }
        }
      }

      const finishReason = choice.finish_reason;
      if (typeof finishReason === "string" && finishReason.length > 0) {
        switch (finishReason) {
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
          default:
            throw new Error(`Qoder 模型服务返回了不支持的结束原因：${finishReason}`);
        }
        return true;
      }
      return false;
    };

    // ---- Read loop ---------------------------------------------------------
    const idleTimeoutMs = parseIdleTimeout();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let pendingJson = "";
    let lastDataAt = Date.now();
    let finishReasonSeen = false;
    let protocolDone = false;
    let sseEventCount = 0;
    const idleError = () => new Error("Qoder 模型服务长时间无响应，已中止本次请求。请稍后重试或切换到其他模型。");

    while (!protocolDone && !finishReasonSeen) {
      let readResult: { done?: boolean; value?: Uint8Array };
      if (idleTimeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              logModelServer("idle-timeout", {
                requestId,
                timeoutMs: idleTimeoutMs,
                elapsedMs: Date.now() - startedAt,
                sseEventCount,
              });
              innerController.abort();
              reject(idleError());
            },
            Math.max(1, idleTimeoutMs - (Date.now() - lastDataAt)),
          );
        });
        const readPromise = reader.read();
        readPromise.catch(() => {});
        try {
          readResult = await Promise.race([readPromise, idle]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } else {
        readResult = await reader.read();
      }

      const { done: transportDone, value } = readResult;
      if (value && value.byteLength > 0) {
        lastDataAt = Date.now();
        buffer += decoder.decode(value, { stream: !transportDone });
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new Error(`Qoder SSE 事件超过 ${MAX_SSE_BUFFER_CHARS} 个字符`);
        }
      }
      if (transportDone) {
        const tail = decoder.decode();
        if (tail) buffer += tail;
        if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
      } else if (!value || value.byteLength === 0) {
        // A broken transport can resolve read() repeatedly without making
        // progress. Yield so it cannot starve the idle timer or the UI.
        await delayWithAbort(10, innerController.signal);
        continue;
      }

      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        // Only the newline itself is a framing artifact: the stream wraps long
        // JSON mid-token (e.g. `"mod` + newline + `el"`), so every other byte
        // of the line is payload and must survive verbatim.
        let line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) {
          // A blank line terminates an event, but never drops an unfinished
          // payload: it may continue on the next line.
          if (pendingJson === "") currentEvent = "";
          continue;
        }
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        const isDataLine = line.startsWith("data:");
        // Inside an unfinished payload, plain continuation lines belong to it.
        if (!isDataLine && pendingJson === "") continue;
        let data = isDataLine ? line.slice(5) : line;
        // SSE allows exactly one optional space after the `data:` field name.
        if (isDataLine && data.startsWith(" ")) data = data.slice(1);

        if (pendingJson === "") {
          if (!data) continue;
          if (data === "[DONE]") {
            protocolDone = true;
            break;
          }
          // qodercli's sentinels: quota notices / notifications framed as data.
          if (data.startsWith("[EXCEED_QUOTA]") || data.startsWith("[NOT_EXCEED_QUOTA]")) {
            throw new Error(
              data.startsWith("[EXCEED_QUOTA]")
                ? "Qoder 积分额度已用完，请升级套餐或充值后重试。"
                : "Qoder 额度校验失败，请稍后重试。",
            );
          }
          if (data.startsWith("[NOTIFICATIONS]")) continue;
          pendingJson = data;
        } else {
          // Join continuation lines without a separator to undo the injected
          // newline; between JSON tokens whitespace is irrelevant anyway.
          pendingJson += data;
        }

        if (!isCompleteJson(pendingJson)) {
          if (pendingJson.length > MAX_SSE_BUFFER_CHARS) {
            throw new Error(`Qoder SSE 事件超过 ${MAX_SSE_BUFFER_CHARS} 个字符`);
          }
          continue;
        }

        const jsonText = pendingJson;
        pendingJson = "";
        const eventName = currentEvent;
        currentEvent = "";

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch (error) {
          logModelServer("unparsable-data", {
            requestId,
            eventName,
            sseEventCount,
            parseError: describeError(error),
            data: jsonText.slice(0, 4000),
          });
          throw new Error(`Qoder 模型服务返回了无法解析的 SSE 数据：${jsonText.slice(0, 200)}`);
        }
        if (!isRecord(parsed)) continue;
        sseEventCount += 1;

        const code = typeof parsed.code === "string" ? parsed.code : "";
        const isErrorPayload = eventName === "error" || (code.length > 0 && !Array.isArray(parsed.choices));
        if (isErrorPayload) {
          const message = typeof parsed.message === "string" ? parsed.message : jsonText.slice(0, 300);
          logModelServer("error-event", { requestId, eventName, code, message, sseEventCount });
          throw new Error(formatModelServerError(code, message, modelLabel(prepared)));
        }

        if (applyChunk(parsed)) finishReasonSeen = true;
      }

      if (transportDone && !protocolDone && !finishReasonSeen) {
        throw new Error("Qoder 模型服务在返回结束标记前中断了连接");
      }
    }

    // ---- Finalize ----------------------------------------------------------
    endThinking();
    for (const state of toolCalls) {
      if (!state?.started || state.ended) continue;
      state.ended = true;
      let parsedArgs: Record<string, unknown> = {};
      const rawArgs = state.args.trim();
      if (rawArgs) {
        const value: unknown = JSON.parse(rawArgs);
        if (!isRecord(value)) throw new Error("Qoder 工具参数不是 JSON 对象");
        parsedArgs = value;
      }
      const block = output.content[state.contentIndex] as ToolCall;
      block.arguments = parsedArgs as ToolCall["arguments"];
      stream.push({
        type: "toolcall_end",
        contentIndex: state.contentIndex,
        toolCall: {
          type: "toolCall",
          id: state.id,
          name: state.name,
          arguments: parsedArgs as ToolCall["arguments"],
        },
        partial: output,
      });
    }

    const hasToolCalls = toolCalls.some((state) => state?.started);
    if (output.stopReason === "toolUse" && !hasToolCalls) {
      throw new Error("Qoder 模型服务返回了 tool_calls 却没有工具调用内容");
    }
    if (hasToolCalls) output.stopReason = "toolUse";

    logModelServer("done", {
      requestId,
      reason: output.stopReason,
      elapsedMs: Date.now() - startedAt,
      sseEventCount,
      contentBlocks: output.content.length,
      usage: output.usage,
    });
    stream.push({
      type: "done",
      reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
      message: output,
    });
    stream.end();
  } catch (error) {
    logModelServer("turn-error", {
      requestId,
      error: describeError(error),
      elapsedMs: Date.now() - startedAt,
      contentBlocks: output.content.length,
    });
    throw error;
  } finally {
    options?.signal?.removeEventListener("abort", onExternalAbort);
    void reader?.cancel().catch(() => {});
    innerController.abort();
  }
}
