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
  formatQoderHttpError,
  getMachineId,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderGlobalDirectModel,
  getQoderMode,
  getQoderUserEmailFallback,
  isQoderCNMode,
  logCosyRequest,
  logCosyResponse,
} from "./cosy.js";
import { getCachedModelConfig } from "./models.js";
import { resolveQoderIdentity } from "./oauth.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";

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
      const identity = await resolveQoderIdentity(accessToken, model.provider, providerMode);
      const userID = identity.userID;
      const name = identity.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User");
      const email = identity.email || getQoderUserEmailFallback(providerMode);
      const machineID = identity.machineID || getMachineId();

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
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
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

      const bodyBytes = Buffer.from(JSON.stringify(reqBody));
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

      const response = await fetch(chatURL, {
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
        signal: options?.signal,
      });
      await logCosyResponse(chatURL, response);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(formatQoderHttpError("api", response.status, response.statusText, errText, chatURL));
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState: ToolCallState[] = [];

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

      stream.push({ type: "start", partial: output });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) break;

          const line = buffer.substring(0, lineEnd).trim();
          buffer = buffer.substring(lineEnd + 1);

          if (!line.startsWith("data:")) continue;
          const dataStr = line.substring(5).trim();
          if (dataStr === "[DONE]") break;

          try {
            const envelope = JSON.parse(dataStr);
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              if (process.env.QODER_DEBUG) {
                console.error(
                  "[pi-provider-qoder] upstream error, sent messages:",
                  JSON.stringify(reqBody.messages, null, 2),
                );
              }
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            if (!innerStr || innerStr === "[DONE]") continue;

            const inner = JSON.parse(innerStr);
            if (inner.id) output.responseId = inner.id as string;
            if (inner.model) output.responseModel = inner.model as string;

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

            if (inner.choices && inner.choices.length > 0) {
              const choice = inner.choices[0];
              const delta = choice.delta;

              if (delta) {
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
                if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallsState[idx]) {
                      toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
                    }
                    const state = toolCallsState[idx];
                    if (tc.id) state.id = tc.id;
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
                    }

                    // id/name can arrive after the block is open; keep it in step.
                    if (state.emittedStart) {
                      const block = output.content[state.contentIndex] as ToolCall;
                      block.id = state.id;
                      block.name = state.name;
                    }

                    if (tc.function?.arguments) {
                      const argDelta = tc.function.arguments;
                      state.arguments += argDelta;
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

              if (choice.finish_reason) {
                // Preserve the real upstream finish_reason instead of forcing "stop".
                output.stopReason = choice.finish_reason as AssistantMessage["stopReason"];
              }
            }
          } catch (e) {
            // A single malformed SSE line shouldn't kill the stream — skip it.
            // But a genuine upstream error must propagate to the outer catch.
            if (e instanceof SyntaxError) {
              if (process.env.QODER_DEBUG) {
                console.error("[pi-provider-qoder] skipping malformed SSE line:", dataStr.slice(0, 200));
              }
              continue;
            }
            throw e;
          }
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
          let args = {};
          try {
            args = JSON.parse(state.arguments || "{}");
          } catch {}
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

      // Guard on blocks that actually reached the message, not on the state array.
      if (toolCallsState.some((state) => state?.emittedStart)) {
        output.stopReason = "toolUse";
      }

      stream.push({
        type: "done",
        reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
        message: output,
      });
      stream.end();
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
