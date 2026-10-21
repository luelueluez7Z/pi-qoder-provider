import { describe, expect, it } from "vitest";
import { fitQoderImagesToBudget, trimQoderMessagesToBudget } from "../request-budget.js";
import type { transformMessagesForQoder } from "../transform.js";

type Messages = ReturnType<typeof transformMessagesForQoder>;
const image = (data: string) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } });
const marker = { type: "text", text: "[Earlier image omitted to fit the request size limit.]" };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

// 1 token ≈ 4 chars; the budget is 70% of contextWindow tokens.
const windowFor = (chars: number) => Math.ceil(chars / 4 / 0.7);
const text = (length: number) => "x".repeat(length);

describe("fitQoderImagesToBudget", () => {
  it("leaves a request at the exact limit unchanged", () => {
    const body = { messages: [{ role: "user", content: [image("abc")] }] as Messages, tools: ["tool"] };
    const result = fitQoderImagesToBudget(body, bytes(body));
    expect(result.omittedImages).toBe(0);
    expect(result.messages).toBe(body.messages);
    expect(result.bodyBytes.toString()).toBe(JSON.stringify(body));
  });

  it("omits only the oldest image needed, preserving text, tool pairs and newer images", () => {
    const body = {
      messages: [
        { role: "system", content: "中文 system" },
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: " ",
          tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call", content: "image result" },
        { role: "user", content: [{ type: "text", text: "截图" }, image("a".repeat(1000)), image("b".repeat(1000))] },
        { role: "user", content: [image("latest")] },
      ] as Messages,
      tools: [{ name: "read" }],
    };
    const original = JSON.stringify(body);
    const expected = JSON.parse(original);
    expected.messages[4].content[1] = marker;
    const result = fitQoderImagesToBudget(body, bytes(expected));
    expect(result.omittedImages).toBe(1);
    expect(JSON.parse(result.bodyBytes.toString())).toEqual(expected);
    expect(result.bodyBytes.byteLength).toBe(bytes(expected));
    expect(JSON.stringify(body)).toBe(original);
  });

  it("omits multiple old images in order without deleting messages", () => {
    const body = {
      messages: [
        { role: "user", content: [image("a".repeat(500)), image("b".repeat(500)), image("latest")] },
      ] as Messages,
    };
    const expected = { messages: [{ role: "user", content: [marker, marker, image("latest")] }] };
    const result = fitQoderImagesToBudget(body, bytes(expected));
    expect(result.omittedImages).toBe(2);
    expect(JSON.parse(result.bodyBytes.toString())).toEqual(expected);
  });

  it("counts UTF-8 bytes and all non-message fields in the budget", () => {
    const body = { messages: [{ role: "user", content: "中文".repeat(100) }] as Messages, tools: "x".repeat(500) };
    expect(() => fitQoderImagesToBudget(body, JSON.stringify(body).length)).toThrow("/compact");
  });

  it("does not discard the newest image even if old-image removal cannot fit", () => {
    const body = {
      messages: [{ role: "user", content: [image("a".repeat(1000)), image("b".repeat(1000))] }] as Messages,
    };
    const original = JSON.stringify(body);
    expect(() => fitQoderImagesToBudget(body, 100)).toThrow("/compact");
    expect(JSON.stringify(body)).toBe(original);
  });

  it("does not discard a sole oversized image", () => {
    const body = { messages: [{ role: "user", content: [image("a".repeat(1000))] }] as Messages };
    expect(() => fitQoderImagesToBudget(body, 100)).toThrow("最新图片");
  });
});

describe("trimQoderMessagesToBudget", () => {
  it("returns the same array when the request already fits", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ] as Messages;
    const result = trimQoderMessagesToBudget(messages, windowFor(10_000));
    expect(result.messages).toBe(messages);
    expect(result.droppedMessages).toBe(0);
    expect(result.truncatedMessages).toBe(0);
  });

  it("drops the oldest messages first and keeps the last user message", () => {
    const oldest = { role: "user", content: `oldest ${text(4000)}` };
    const messages = [
      oldest,
      { role: "assistant", content: `middle ${text(4000)}` },
      { role: "user", content: `newest ${text(4000)}` },
    ] as Messages;
    const result = trimQoderMessagesToBudget(messages, windowFor(6000));
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: `newest ${text(4000)}` });
    expect(result.messages).not.toContainEqual(oldest);
  });

  it("never leaves an orphaned tool result when dropping", () => {
    const messages = [
      {
        role: "assistant",
        content: " ",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: text(3000) } }],
      },
      { role: "tool", tool_call_id: "call-1", content: text(3000) },
      { role: "user", content: "now summarize" },
    ] as Messages;
    const result = trimQoderMessagesToBudget(messages, windowFor(3000));
    const keptIds = new Set(
      result.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id as string),
    );
    for (const message of result.messages) {
      if (message.role !== "assistant" || !message.tool_calls) continue;
      for (const call of message.tool_calls) {
        if (call.id) expect(keptIds.has(call.id)).toBe(true);
      }
    }
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "now summarize" });
  });

  it("clips the last user message when nothing else can be dropped", () => {
    const messages = [{ role: "user", content: text(200_000) }] as Messages;
    const result = trimQoderMessagesToBudget(messages, windowFor(4000));
    expect(result.droppedMessages).toBe(0);
    expect(result.truncatedMessages).toBe(1);
    expect((result.messages[0].content as string).length).toBeLessThan(200_000);
  });

  it("charges images a fixed token cost instead of their base64 length", () => {
    const messages = [
      { role: "user", content: [image("a".repeat(400_000))] },
      { role: "user", content: "describe it" },
    ] as Messages;
    const result = trimQoderMessagesToBudget(messages, windowFor(20_000));
    // The image costs 1000 tokens (~28000 chars at 4 chars/token in the
    // estimate), which fits a 20k-char window; a base64-based count would not.
    expect(result.droppedMessages).toBe(0);
  });
});
