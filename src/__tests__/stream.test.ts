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
import { resetQoderQuotaCache } from "../usage.js";

// A quota endpoint response that reports credits remaining (not exhausted).
const QUOTA_OK_JSON = JSON.stringify({
  isQuotaExceeded: false,
  userQuota: { total: 100, used: 10, remaining: 90, percentage: 0.1, unit: "credits" },
  orgResourcePackage: { total: 100, used: 0, remaining: 100, percentage: 0, unit: "credits" },
});

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

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
      return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
    }
    if (url.includes("/quota/usage")) {
      return jsonResponse(QUOTA_OK_JSON);
    }
    return response;
  }) as unknown as typeof fetch;
}

/** Return a chat response whose body emits the supplied SSE data but never closes. */
function openEndedFetch(body: string, onCancel: () => void): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/userinfo")) {
      return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
    }
    if (url.includes("/quota/usage")) {
      return jsonResponse(QUOTA_OK_JSON);
    }
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel() {
        onCancel();
      },
    });
    return new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Return a chat response whose body repeatedly yields empty chunks. */
function zeroProgressFetch(onCancel: () => void): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/userinfo")) {
      return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
    }
    if (url.includes("/quota/usage")) {
      return jsonResponse(QUOTA_OK_JSON);
    }
    const responseBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        onCancel();
      },
    });
    return new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Return a fresh Response per call, so each chat attempt gets its own body. */
function sequenceFetch(bodies: string[]): typeof fetch {
  let call = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/userinfo")) {
      return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
    }
    if (url.includes("/quota/usage")) {
      return jsonResponse(QUOTA_OK_JSON);
    }
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function chatFetchCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((c) => {
    const url = String(c[0]);
    return !url.includes("/userinfo") && !url.includes("/quota/usage");
  }).length;
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
    delete process.env.QODER_IDLE_TIMEOUT_MS;
    delete process.env.QODER_STREAM_TIMEOUT_MS;
    delete process.env.QODER_HTTP_TIMEOUT_MS;
    resetQoderQuotaCache();
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

  it.each([
    ["nested Qoder envelope", DONE_SSE],
    ["raw SSE marker", "data: [DONE]\n\n"],
  ])("finishes at the %s DONE marker without waiting for transport EOF", async (_label, doneMarker) => {
    let cancelled = false;
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + doneMarker;
    globalThis.fetch = openEndedFetch(sse, () => {
      cancelled = true;
    });

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await Promise.race([
      consume(stream),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream waited for transport EOF")), 250)),
    ]);

    expect(
      events.find((event) => event.type === "done"),
      "expected a done event at the protocol marker",
    ).toBeDefined();
    expect(cancelled, "the still-open response body should be cancelled").toBe(true);
  });

  it("rejects a transport EOF that arrives before a terminal response event", async () => {
    globalThis.fetch = mockFetch(sseEnvelope(chunk({ content: "partial", role: "assistant" })));
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an error event for a truncated stream").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("ended before a terminal response event");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("rejects malformed SSE JSON instead of treating it as a successful response", async () => {
    globalThis.fetch = mockFetch("data:{not-json}\n\n");
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an error event for malformed SSE").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("malformed SSE JSON");
  });

  it("rejects malformed tool arguments instead of executing an empty object", async () => {
    const malformedTool =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call-1", function: { name: "bash", arguments: '{"command":' } }],
        }),
      ) + sseEnvelope(finishChunk("tool_calls"));
    globalThis.fetch = mockFetch(malformedTool);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an error event for malformed tool arguments").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("Unexpected end");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("rejects a tool_calls finish reason when no tool call was emitted", async () => {
    globalThis.fetch = mockFetch(sseEnvelope(finishChunk("tool_calls")));
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an error event for an empty tool_calls response").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("without a tool call");
  });

  it("aborts a response that remains open after data without a terminal event", async () => {
    process.env.QODER_STREAM_TIMEOUT_MS = "50";
    globalThis.fetch = openEndedFetch(sseEnvelope(chunk({ content: "partial", role: "assistant" })), () => {});
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an error event after the stream timeout").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("stream timeout");
  });

  it("times out a chat connection that never returns response headers", async () => {
    process.env.QODER_HTTP_TIMEOUT_MS = "20";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/userinfo")) return jsonResponse(JSON.stringify({ id: "user-test" }));
      if (url.includes("/quota/usage")) return jsonResponse(QUOTA_OK_JSON);
      return await new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);
    const err = events.find((event) => event.type === "error");
    expect(err, "expected a connection timeout error").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toContain("chat connection timeout");
  });

  it("surfaces an upstream 406 'Session blocked' as an error event and releases its response body", async () => {
    let cancelled = false;
    globalThis.fetch = openEndedFetch(BLOCKED_SSE, () => {
      cancelled = true;
    });
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
    expect(cancelled, "the errored response body should be cancelled").toBe(true);
  });

  it("times out repeated empty reads without starving the event loop", async () => {
    process.env.QODER_IDLE_TIMEOUT_MS = "30";
    let cancelled = false;
    globalThis.fetch = zeroProgressFetch(() => {
      cancelled = true;
    });

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await Promise.race([
      consume(stream),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("empty reads caused a busy loop")), 250)),
    ]);

    const err = events.find((event) => event.type === "error");
    expect(err, "expected an idle timeout error").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toMatch(/长时间未返回响应/);
    expect(cancelled, "the zero-progress response body should be cancelled").toBe(true);
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

  it("buffers tool arguments until the call identity arrives", async () => {
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_10", function: { name: "bash" } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const done = events.find((event) => event.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((content) => content.type === "toolCall") as ToolCall | undefined;
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

  it("fails fast with a friendly message when the quota is exhausted", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/userinfo")) {
        return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
      }
      if (url.includes("/quota/usage")) {
        return jsonResponse(
          JSON.stringify({
            isQuotaExceeded: true,
            userQuota: { total: 3000, used: 3000, remaining: 0, percentage: 1, unit: "credits" },
            orgResourcePackage: { total: 100, used: 100, remaining: 0, percentage: 1, unit: "credits" },
            upgradeUrl: "https://qoder.com/pricing",
          }),
        );
      }
      throw new Error("chat endpoint must not be called when the quota is exhausted");
    }) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event when the quota is exhausted").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/额度已用完/);
    // The chat request must never be issued; only userinfo + quota checks ran.
    expect(chatFetchCalls(globalThis.fetch as ReturnType<typeof vi.fn>)).toBe(0);
  });

  it("aborts a hung stream after the idle timeout with a friendly message", async () => {
    process.env.QODER_IDLE_TIMEOUT_MS = "100";
    // The chat endpoint answers HTTP 200 but its body never delivers a byte
    // (the upstream behaviour when the quota is exhausted).
    const hanging = new ReadableStream({
      start(controller) {
        // Never enqueue or close — the stream just hangs.
        void controller;
      },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/userinfo")) {
        return jsonResponse(JSON.stringify({ id: "user-test", email: "t@qoder.com", name: "T" }));
      }
      if (url.includes("/quota/usage")) {
        return jsonResponse(QUOTA_OK_JSON);
      }
      return new Response(hanging, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event after the idle timeout").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.errorMessage).toMatch(/长时间未返回响应/);
  });
});
