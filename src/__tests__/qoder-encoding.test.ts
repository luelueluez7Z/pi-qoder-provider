import { describe, expect, it } from "vitest";
import { qoderEncodeBody } from "../qoder-encoding.js";

describe("qoderEncodeBody", () => {
  it("encodes a simple string", () => {
    const result = qoderEncodeBody("hello");
    expect(result).toBe("q$FruHPH");
    expect(typeof result).toBe("string");
    expect(result).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    const result = qoderEncodeBody(buf);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("produces deterministic output", () => {
    expect(qoderEncodeBody("test input")).toBe(qoderEncodeBody("test input"));
  });

  it("produces different output for different inputs", () => {
    expect(qoderEncodeBody("input A")).not.toBe(qoderEncodeBody("input B"));
  });

  it("handles empty string and buffer", () => {
    expect(qoderEncodeBody("")).toBe("");
    expect(qoderEncodeBody(Buffer.alloc(0))).toBe("");
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding.
    const result = qoderEncodeBody("a");
    expect(result).not.toContain("=");
    expect(result).toContain("$");
  });

  it("uses the custom alphabet (differs from standard base64)", () => {
    const result = qoderEncodeBody("The quick brown fox");
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(result).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = qoderEncodeBody(binary);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const result = qoderEncodeBody(json);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });
});
