import { describe, expect, it } from "vitest";
import { fitQoderImagesToBudget } from "../request-budget.js";
import type { transformMessagesForQoder } from "../transform.js";

type Messages = ReturnType<typeof transformMessagesForQoder>;
const image = (data: string) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,${data}` } });
const marker = { type: "text", text: "[Earlier image omitted to fit the request size limit.]" };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

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
