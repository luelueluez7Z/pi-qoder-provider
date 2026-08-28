import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamQoder } from "../stream.js";

/** Build a single SSE `data:` line carrying a Qoder envelope. */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE =
  sseEnvelope(chunk({ role: "assistant" })) +
  sseEnvelope(chunk({ reasoning_content: "The user wants OK.", role: "assistant" })) +
  sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
  sseEnvelope(finishChunk("stop")) +
  DONE_SSE;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

// A 10605 "model queued" payload, wrapped in the nested upstream envelope.
const QUEUED_SSE = sseEnvelope(
  {
    code: "403",
    message: JSON.stringify({
      code: "10605",
      message: JSON.stringify({
        isQueued: true,
        modelKey: "ultimate",
        queueCount: 1033,
        queueType: "slow",
        retryAfterSeconds: 0,
        serviceAvailable: true,
        waitTime: 0,
      }),
    }),
  },
  403,
  "Forbidden",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // resolveQoderIdentity calls /userinfo first (when auth.json is missing);
    // return a valid identity so the chat request proceeds.
    if (url.includes("/userinfo")) {
      return new Response(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  }) as unknown as typeof fetch;
}

/** Return a fresh Response per call, so each chat attempt gets its own body. */
function sequenceFetch(bodies: string[]): typeof fetch {
  let call = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/userinfo")) {
      return new Response(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function chatFetchCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => !String(c[0]).includes("/userinfo")).length;
}

function makeModel(): Model<Api> {
  return { id: "ultimate", api: "qoder-api" as Api, provider: "qoder", contextWindow: 1000000 } as Model<Api>;
}

function makeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context;
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.QODER_QUEUE_RETRY_MAX;
    vi.restoreAllMocks();
  });

  it("parses a successful SSE stream into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("surfaces an upstream 406 'Session blocked' as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage, responseId and responseModel from the finish chunk", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            // prompt_tokens (42) INCLUDES cached_tokens (5) per OpenAI
            // semantics; pi expects input to exclude them (promptTokens =
            // input + cacheRead + cacheWrite), so input = 42 - 5 - 10 = 27.
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    expect(msg.responseModel).toBe("qmodel_latest");
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
  });

  it("folds Qoder credits into usage.cost for footer accumulation", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          usage: {
            prompt_tokens: 13,
            completion_tokens: 11,
            total_tokens: 24,
            billable: true,
            credits: 0.0007885714285714286,
            original_credits: 0.0007885714285714286,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    // total must equal the upstream credits so pi's footer accumulates them.
    expect(msg.usage.cost.total).toBeCloseTo(0.0007885714285714286, 12);
    // input/output split by token share (13 prompt / 24 total, 11 completion / 24 total).
    expect(msg.usage.cost.input).toBeCloseTo((0.0007885714285714286 * 13) / 24, 12);
    expect(msg.usage.cost.output).toBeCloseTo((0.0007885714285714286 * 11) / 24, 12);
  });

  it("keeps cost zeroed when the usage tail carries no credits", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(finishChunk("stop", { usage: { prompt_tokens: 13, completion_tokens: 11, total_tokens: 24 } })) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.usage.cost.total).toBe(0);
    expect(msg.usage.cost.input).toBe(0);
    expect(msg.usage.cost.output).toBe(0);
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    const toolCall = msg.content.find((c) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
  });

  it("emits a tool call that arrives with no arguments", async () => {
    // A no-argument tool: the block used to be created only when arguments were
    // present, so the finalizer claimed toolUse on a message with no tool call,
    // dead-ending the turn.
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall, "a named tool call must reach the message even with no arguments").toBeDefined();
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    // Streamed the other way round: arguments first, identity later.
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    // A malformed stream: a tool_calls delta with neither id nor name.
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });

  it("auto-retries after a 10605 queue response and then succeeds", async () => {
    globalThis.fetch = sequenceFetch([QUEUED_SSE, SUCCESS_SSE]);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after the queue retry").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    // The live queue notice is a leading text block; the real reply follows it.
    const texts = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
    expect(texts[0]).toContain("排队中");
    expect(texts[1]).toBe("OK");
    // userinfo once + queued chat attempt + successful chat attempt.
    expect(chatFetchCalls(globalThis.fetch as ReturnType<typeof vi.fn>)).toBe(2);
  });

  it("surfaces the friendly queue error when retries are exhausted", async () => {
    process.env.QODER_QUEUE_RETRY_MAX = "1";
    globalThis.fetch = sequenceFetch([QUEUED_SSE, QUEUED_SSE, QUEUED_SSE]);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event after the queue retries run out").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/正在排队/);
    // One initial attempt + one retry.
    expect(chatFetchCalls(globalThis.fetch as ReturnType<typeof vi.fn>)).toBe(2);
  });

  it("does not auto-retry when QODER_QUEUE_RETRY_MAX=0", async () => {
    process.env.QODER_QUEUE_RETRY_MAX = "0";
    globalThis.fetch = sequenceFetch([QUEUED_SSE, SUCCESS_SSE]);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event when auto-retry is disabled").toBeDefined();
    expect(chatFetchCalls(globalThis.fetch as ReturnType<typeof vi.fn>)).toBe(1);
  });
});
