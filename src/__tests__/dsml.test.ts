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

  // Real-world degenerate form captured from a deepseek-v4-flash session: the
  // `<invoke>` opener is missing and closes use the `｜DSML｜` (U+FF5C) wrapper.
  const degenerate =
    '<parameter name="command">cd D:\\proj</parameter>\n</invoke>\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

  it("recovers a degenerate opener-less invocation (single chunk)", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push(degenerate);
    parser.finish();

    expect(text.join("")).toBe("");
    expect(tools).toEqual([
      { name: "powershell", arguments: { command: "cd D:\\proj" } },
    ]);
  });

  it("recovers a degenerate invocation split across deltas", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push('<parameter name="command">cd D:\\pro');
    parser.push('ject</parameter>\n</invoke>\n</｜DSML｜');
    parser.push(' parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>then real text');
    parser.finish();

    expect(tools).toEqual([
      { name: "powershell", arguments: { command: "cd D:\\project" } },
    ]);
    expect(text.join("")).toBe("then real text");
  });

  it("keeps a degenerate invocation with un-inferrable parameters as text", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push('<parameter name="widget">x</parameter>\n</invoke>\n</invoke>');
    parser.finish();

    expect(tools).toEqual([]);
    expect(text.join("")).toBe('<parameter name="widget">x</parameter>\n</invoke>\n</invoke>');
  });

  it("keeps mid-line parameter tags in prose as text", () => {
    const text: string[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      () => {
        throw new Error("unexpected tool call");
      },
    );

    parser.push('use the <parameter name="x"> tag carefully');
    parser.finish();

    expect(text.join("")).toBe('use the <parameter name="x"> tag carefully');
  });

  it("normalizes ｜DSML｜-wrapped complete invocations", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push(
      '<｜DSML｜ invoke name="bash"><｜DSML｜ parameter name="command">ls</｜DSML｜ parameter></｜DSML｜ invoke>',
    );
    parser.finish();

    expect(text.join("")).toBe("");
    expect(tools).toEqual([{ name: "bash", arguments: { command: "ls" } }]);
  });

  it("emits a complete invocation whose close arrives in a later delta", () => {
    const text: string[] = [];
    const tools: unknown[] = [];
    const parser = new DsmlToolParser(
      (value) => text.push(value),
      (tool) => tools.push(tool),
    );

    parser.push('<invoke name="bash">\n<parameter name="command">echo hi</parameter>');
    parser.push("\n</invoke>");
    parser.finish();

    expect(text.join("")).toBe("");
    expect(tools).toEqual([{ name: "bash", arguments: { command: "echo hi" } }]);
  });

  describe("incompleteOnly (reasoning channel)", () => {
    it("recovers a degenerate invocation", () => {
      const text: string[] = [];
      const tools: unknown[] = [];
      const parser = new DsmlToolParser(
        (value) => text.push(value),
        (tool) => tools.push(tool),
        { incompleteOnly: true },
      );

      parser.push("thinking out loud\n\n");
      parser.push(degenerate);
      parser.finish();

      expect(text.join("")).toBe("thinking out loud\n\n");
      expect(tools).toEqual([
        { name: "powershell", arguments: { command: "cd D:\\proj" } },
      ]);
    });

    it("never parses a complete invoke draft as a tool", () => {
      const text: string[] = [];
      const tools: unknown[] = [];
      const parser = new DsmlToolParser(
        (value) => text.push(value),
        (tool) => tools.push(tool),
        { incompleteOnly: true },
      );

      parser.push('draft: <invoke name="bash"><parameter name="command">ls</parameter></invoke>');
      parser.finish();

      expect(tools).toEqual([]);
      expect(text.join("")).toBe(
        'draft: <invoke name="bash"><parameter name="command">ls</parameter></invoke>',
      );
    });
  });
});
