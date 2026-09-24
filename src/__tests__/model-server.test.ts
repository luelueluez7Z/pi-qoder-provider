import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildModelServerBody,
  canDisableThinking,
  fitBodyToBudget,
  formatModelServerError,
  getQoderModelServerChatURL,
  isCompleteJson,
  useQoderModelServer,
} from "../model-server.js";
import { prepareQoderRequest } from "../prepare.js";
import { streamQoder } from "../stream.js";
import { resetQoderQuotaCache } from "../usage.js";

const QUOTA_OK_JSON = JSON.stringify({
  isQuotaExceeded: false,
  userQuota: { total: 100, used: 10, remaining: 90, percentage: 0.1, unit: "credits" },
});

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** One plain (unwrapped) OpenAI-style SSE frame, as the model server emits it. */
function msFrame(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function msChunk(delta: object, extra: object = {}): string {
  return msFrame({
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "resp-1",
    model: "dmodel",
    object: "chat.completion.chunk",
    ...extra,
  });
}

const USAGE = {
  completion_tokens: 12,
  completion_tokens_details: { reasoning_tokens: 5 },
  prompt_tokens: 100,
  prompt_tokens_details: { cached_tokens: 40 },
  total_tokens: 112,
};

/** Reasoning + text + a native streaming tool call + usage + [DONE]. */
const TOOL_CALL_SSE =
  msChunk({ role: "assistant", content: null, reasoning_content: "" }) +
  msChunk({ reasoning_content: "Need the weather." }) +
  msChunk({ content: "Let me check." }) +
  msChunk({
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }],
  }) +
  msChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Bei' } }] }) +
  msChunk({ tool_calls: [{ index: 0, function: { arguments: 'jing"}' } }] }) +
  msChunk({ content: "" }, { finish_reason: "tool_calls", usage: USAGE }) +
  "data: [DONE]\n\n";

const TEXT_SSE =
  msChunk({ role: "assistant", content: null, reasoning_content: "" }) +
  msChunk({ content: "Hello" }) +
  msChunk({ content: " world" }) +
  msChunk({ content: "" }, { finish_reason: "stop", usage: USAGE }) +
  "data: [DONE]\n\n";

const INVALID_MODEL_SSE = `event: error\ndata: ${JSON.stringify({
  code: "invalid_model_error",
  message: 'Unsupported model "dfmodel"',
  request_id: "r1",
  type: "invalid_model_error",
})}\n\n`;

const EXCEED_QUOTA_SSE = "data: [EXCEED_QUOTA] credits exhausted\n\n";

// The stream wraps long JSON chunks mid-token: the terminal `raw_usage` block is
// ~1KB and arrives with raw newlines injected into the payload (observed:
// `"mod` + newline + `el":"oem-deepseek-v4-pro"`). Those bytes must be stitched
// back together, so `model`/`usage` survive the wrap.
const MULTILINE_SSE =
  msChunk({ role: "assistant", content: null }) +
  msChunk({ content: "PONG" }) +
  'data: {"choices":[{"delta":{"content":"","reasoning_content":null},"finish_reason":"stop","index":0}],\n"created":1,"id":"resp-1","mod\nel":"dmodel",\n"raw_usage":{"account_discount":0,\n"target":"oem-deepseek-v4-pro"},\n"usage":{"completion_tokens":3,"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":4},"total_tokens":13}}\n\n' +
  "data: [DONE]\n\n";

/** Capture chat requests and answer them with `sse`. */
function modelServerFetch(sse: string): { fetch: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/userinfo")) {
      return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
    }
    if (url.includes("/quota/usage")) return jsonResponse(QUOTA_OK_JSON);
    if (url.includes("/model/v1/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return { fetch: fetchMock as unknown as typeof fetch, bodies };
}

function makeModel(id = "dmodel", provider = "qoder"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider, contextWindow: 200000 } as Model<Api>;
}

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are a test bot.",
    messages: [{ role: "user", content: "weather?", timestamp: Date.now() }],
    tools: [
      {
        name: "get_weather",
        description: "Get the weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  });
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((e) => e.type === "done");
  expect(done, "expected a done event").toBeDefined();
  return (done as { message: AssistantMessage }).message;
}

function errorMessage(events: AssistantMessageEvent[]): string {
  const error = events.find((e) => e.type === "error");
  expect(error, "expected an error event").toBeDefined();
  return (error as { error: AssistantMessage }).error.errorMessage ?? "";
}

describe("model-server transport", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.QODER_PROTOCOL = "v2";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.QODER_PROTOCOL;
    delete process.env.QODER_IDLE_TIMEOUT_MS;
    delete process.env.QODER_HTTP_TIMEOUT_MS;
    resetQoderQuotaCache();
    vi.restoreAllMocks();
  });

  it("streams text and a native tool call into pi events", async () => {
    const { fetch: fetchMock, bodies } = modelServerFetch(TOOL_CALL_SSE);
    globalThis.fetch = fetchMock;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", sessionId: "sess-1" }));
    const msg = doneMessage(events);

    expect(msg.stopReason).toBe("toolUse");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("Let me check.");
    const thinking = msg.content.find((c) => c.type === "thinking");
    expect(thinking && "thinking" in thinking ? thinking.thinking : "").toBe("Need the weather.");
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall;
    expect(toolCall.name).toBe("get_weather");
    expect(toolCall.id).toBe("call_1");
    expect(toolCall.arguments).toEqual({ city: "Beijing" });

    // usage: prompt_tokens includes cached tokens, pi wants them split out
    expect(msg.usage.input).toBe(60);
    expect(msg.usage.output).toBe(12);
    expect(msg.usage.cacheRead).toBe(40);
    expect(msg.usage.totalTokens).toBe(112);

    // The request must carry the system prompt, tools, reasoning level and context.
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.model).toBe("dmodel");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    const messages = body.messages as Array<{ role: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.reasoning).toEqual({ effort: "none" });
    const context = (body.metadata as { context: Record<string, unknown> }).context;
    expect(context.client_type).toBe("5");
    expect(context.task_id).toBe("common");
    expect(String(context.session_id)).toContain("sess-1");
  });

  it("streams plain text and reports a stop reason", async () => {
    const { fetch: fetchMock } = modelServerFetch(TEXT_SSE);
    globalThis.fetch = fetchMock;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = doneMessage(events);

    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("Hello world");
  });

  it("repairs a terminal chunk wrapped mid-token by the stream", async () => {
    const { fetch: fetchMock } = modelServerFetch(MULTILINE_SSE);
    globalThis.fetch = fetchMock;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = doneMessage(events);

    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("PONG");
    // the key split as `"mod` + newline + `el"` must be stitched back
    expect(msg.responseModel).toBe("dmodel");
    expect(msg.usage.input).toBe(6);
    expect(msg.usage.output).toBe(3);
    expect(msg.usage.cacheRead).toBe(4);
  });

  it("surfaces a business error event with a friendly message", async () => {
    const { fetch: fetchMock } = modelServerFetch(INVALID_MODEL_SSE);
    globalThis.fetch = fetchMock;

    // No silent legacy fallback: the model server's rejection is the answer.
    const events = await consume(streamQoder(makeModel("dfmodel"), makeContext(), { apiKey: "fake" }));
    expect(errorMessage(events)).toContain("QODER_PROTOCOL=legacy");
  });

  it("surfaces the quota sentinel as an error", async () => {
    const { fetch: fetchMock } = modelServerFetch(EXCEED_QUOTA_SSE);
    globalThis.fetch = fetchMock;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(errorMessage(events)).toContain("积分额度已用完");
  });
});

describe("model-server routing", () => {
  afterEach(() => {
    delete process.env.QODER_PROTOCOL;
    delete process.env.QODER_MODEL_SERVER_HOST;
  });

  it("routes every global model to the model server and keeps CN on the legacy gateway", () => {
    delete process.env.QODER_PROTOCOL;
    expect(useQoderModelServer("global")).toBe(true);
    expect(useQoderModelServer("cn")).toBe(false);
  });

  it("honours explicit v2 / legacy settings", () => {
    process.env.QODER_PROTOCOL = "v2";
    expect(useQoderModelServer("cn")).toBe(true);
    process.env.QODER_PROTOCOL = "legacy";
    expect(useQoderModelServer("global")).toBe(false);
  });

  it("uses the model-server URL, honouring the host override", () => {
    expect(getQoderModelServerChatURL()).toBe("https://api2-v2.qoder.sh/model/v1/chat/completions");
    process.env.QODER_MODEL_SERVER_HOST = "https://example.test/";
    expect(getQoderModelServerChatURL()).toBe("https://example.test/model/v1/chat/completions");
  });

  it("formats known error codes in Chinese", () => {
    expect(formatModelServerError("invalid_model_error", "Unsupported model", "DeepSeek-Flash（dfmodel）")).toContain(
      "DeepSeek-Flash（dfmodel）",
    );
    expect(formatModelServerError("provider_error", "All models failed", "dmodel")).toContain("上游模型调用失败");
  });
});

describe("isCompleteJson", () => {
  it("waits for a balanced object and tolerates newlines inside it", () => {
    expect(isCompleteJson('{"a":1}')).toBe(true);
    expect(isCompleteJson('{"a":"}"')).toBe(false);
    expect(isCompleteJson('{"a":1,\n"b":{"c":2}')).toBe(false);
    expect(isCompleteJson('{"a":1,\n"b":{"c":2}}')).toBe(true);
    expect(isCompleteJson('{"a":"line\\n"}')).toBe(true);
  });

  it("treats non-object payloads as complete", () => {
    expect(isCompleteJson("[DONE]")).toBe(true);
    expect(isCompleteJson("plain text")).toBe(true);
  });
});

describe("canDisableThinking", () => {
  it("follows the catalog's disabled mode", () => {
    // DeepSeek V4 declares thinking_config.disabled; Cantus does not.
    expect(canDisableThinking({ thinking_config: { disabled: { description: "Disable thinking" } } })).toBe(true);
    expect(canDisableThinking({ thinking_config: { enabled: { efforts: { high: {} } } } })).toBe(false);
    expect(canDisableThinking({})).toBe(false);
  });
});

describe("fitBodyToBudget", () => {
  const msg = (role: string, content: string, extra: Record<string, unknown> = {}) => ({ role, content, ...extra });
  const size = (body: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(body));
  const orphanTools = (messages: Array<Record<string, unknown>>) => {
    const open = new Set<string>();
    let orphans = 0;
    for (const m of messages) {
      for (const tc of (m.tool_calls as Array<{ id: string }> | undefined) ?? []) open.add(tc.id);
      if (m.role === "tool") {
        if (open.has(String(m.tool_call_id))) open.delete(String(m.tool_call_id));
        else orphans += 1;
      }
    }
    return orphans;
  };

  it("leaves a body that fits untouched", () => {
    const body = { model: "dfmodel", messages: [msg("system", "s"), msg("user", "hi")] };
    const fit = fitBodyToBudget(body, 10_000);
    expect(fit.body).toBe(body);
    expect(fit.droppedMessages).toBe(0);
    expect(fit.clippedMessages).toBe(0);
  });

  it("drops oldest messages at user boundaries and keeps tool pairs intact", () => {
    const pad = "x".repeat(600);
    const messages = [
      msg("system", "s"),
      msg("user", `old question ${pad}`),
      msg("assistant", "", {
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      }),
      msg("tool", `old result ${pad}`, { tool_call_id: "c1", name: "read" }),
      msg("assistant", `old answer ${pad}`),
      msg("user", "newest question"),
    ];
    const budget = size({ ...{ model: "dfmodel" }, messages: [messages[0], msg("user", "newest question")] }) + 40;
    const fit = fitBodyToBudget({ model: "dfmodel", messages }, budget);

    expect(size(fit.body)).toBeLessThanOrEqual(budget);
    expect(fit.droppedMessages).toBeGreaterThan(0);
    expect(fit.clippedMessages).toBe(0);
    const kept = fit.body.messages as Array<Record<string, unknown>>;
    expect(kept[0].role).toBe("system");
    expect(kept[1].role).toBe("user");
    expect(kept.at(-1)).toMatchObject({ content: "newest question" });
    expect(orphanTools(kept)).toBe(0);
  });

  it("clips contents when even the newest turn alone exceeds the budget", () => {
    const body = {
      model: "dfmodel",
      messages: [msg("system", "s"), msg("user", "q"), msg("tool", "y".repeat(20_000), { tool_call_id: "c1" })],
    };
    const fit = fitBodyToBudget(body, 2_000);

    expect(size(fit.body)).toBeLessThanOrEqual(2_000);
    expect(fit.clippedMessages).toBeGreaterThan(0);
    const kept = fit.body.messages as Array<Record<string, unknown>>;
    expect(String(kept.at(-1)?.content)).toContain("已截断");
  });
});

describe("business identity", () => {
  it("declares the CLI business product so the model registry resolves catalog keys", async () => {
    const prepared = await prepareQoderRequest(makeModel("dfmodel"), makeContext(), { apiKey: "fake" });
    const body = buildModelServerBody(prepared, "rid-biz");
    const metadata = body.metadata as { business?: Record<string, unknown> };

    // Without metadata.business the model server answers invalid_model_error for
    // keys that only the CLI product knows (dfmodel, qmodel_38max, gfmodel, ...).
    expect(metadata.business).toEqual({ product: "cli", type: "agent" });
    // The catalog key goes on the wire verbatim — no local name mapping.
    expect(body.model).toBe("dfmodel");
  });
});

describe("buildModelServerBody", () => {
  it("omits tools/reasoning/context_length when unused", async () => {
    const model = makeModel("efmodel");
    const context = normalizeContext({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      tools: [],
    });
    const prepared = await prepareQoderRequest(model, context, { apiKey: "fake" });
    const body = buildModelServerBody(prepared, "rid-1");

    expect(body.tools).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.parameters).toBeUndefined();
    expect((body.metadata as { context: { request_id: string } }).context.request_id).toBe("rid-1");
  });
});
