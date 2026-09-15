import { describe, expect, it } from "vitest";
import { DsmlToolParser } from "../dsml.js";

describe("DsmlToolParser", () => {
  it("converts a chunked invoke into a tool call", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push("before<inv");
    parser.push(
      'oke name="ask_user"><parameter name="remark">Need &lt;help&gt;</parameter><parameter name="options" string="false">[{"title":"Yes"}]</parameter></invoke>after',
    );
    parser.finish();

    expect(text.join("")).toBe("beforeafter");
    expect(tools).toEqual([
      {
        name: "ask_user",
        arguments: { remark: "Need <help>", options: [{ title: "Yes" }] },
      },
    ]);
  });

  it("keeps an incomplete invocation as text", () => {
    const text: string[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      () => {
        throw new Error("unexpected tool call");
      },
    );

    parser.push('answer <invoke name="bash">');
    parser.finish();

    expect(text.join("")).toBe('answer <invoke name="bash">');
  });
});
