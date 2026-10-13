import { describe, expect, it } from "vitest";
import { describeQoderMessages, describeQoderText } from "../request-diagnostics.js";

describe("request diagnostics", () => {
  it("identifies summary instructions and tags without logging prompt contents", () => {
    const text = "Your task is to create a detailed summary. <analysis>secret</analysis><summary>summary</summary>";
    const result = describeQoderText(text);
    expect(result.summaryInstructions).toContain("detailed-summary");
    expect(result.tags).toMatchObject({ analysis: 2, summary: 2 });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.sha256).toHaveLength(64);
  });

  it("does not expose tokens, thinking, tool arguments, or image bytes", () => {
    const result = describeQoderMessages([
      { role: "system", content: "token=private-system-token" },
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "private-thought",
        tool_calls: [
          { id: "call", type: "function", function: { name: "read", arguments: '{"password":"private-password"}' } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Bearer private-user-token" },
          { type: "image_url", image_url: { url: "data:image/png;base64,private-image-bytes" } },
        ],
      },
    ]);
    expect(result[1].reasoning?.chars).toBe("private-thought".length);
    expect(result[2].images).toEqual([{ urlChars: "data:image/png;base64,private-image-bytes".length, inline: true }]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});
