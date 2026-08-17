import { describe, expect, it } from "vitest";
import {
  decodePatRefresh,
  encodeJobRefresh,
  encodePatRefresh,
  isPatRefresh,
  JRT_REFRESH_PREFIX,
  PAT_REFRESH_PREFIX,
} from "../pat.js";

describe("pat/jrt refresh encoding", () => {
  it("encodes a job-token refresh WITHOUT the plaintext PAT", () => {
    const encoded = encodeJobRefresh("jrt-xyz", "user-1", "machine-1");
    expect(encoded).toBe("jrt|jrt-xyz|user-1|machine-1");
    expect(isPatRefresh(encoded)).toBe(true);
    expect(decodePatRefresh(encoded)).toEqual({
      pat: "",
      jobRefreshToken: "jrt-xyz",
      userID: "user-1",
      machineID: "machine-1",
      legacyEmbeddedPat: false,
    });
  });

  it("legacy encodePatRefresh never embeds the PAT (migrates to jrt)", () => {
    const encoded = encodePatRefresh("pt-abc", "jrt-xyz", "user-1", "machine-1");
    expect(encoded).toBe("jrt|jrt-xyz|user-1|machine-1");
    expect(encoded).not.toContain("pt-abc");
    expect(encoded).not.toContain("pt-");
  });

  it("decodes legacy pat-format refresh and flags embedded PAT", () => {
    const decoded = decodePatRefresh("pat|pt-abc|jrt-xyz|user-1|machine-1");
    expect(decoded.pat).toBe("pt-abc");
    expect(decoded.jobRefreshToken).toBe("jrt-xyz");
    expect(decoded.userID).toBe("user-1");
    expect(decoded.machineID).toBe("machine-1");
    expect(decoded.legacyEmbeddedPat).toBe(true);
  });

  it("handles missing segments when decoding jrt format", () => {
    const decoded = decodePatRefresh("jrt|only-jrt");
    expect(decoded.jobRefreshToken).toBe("only-jrt");
    expect(decoded.userID).toBe("");
    expect(decoded.machineID).toBe("");
    expect(decoded.legacyEmbeddedPat).toBe(false);
  });

  it("detects both jrt and pat refresh prefixes", () => {
    expect(isPatRefresh("jrt|abc|u|m")).toBe(true);
    expect(isPatRefresh("pat|pt-x|abc|u|m")).toBe(true);
    expect(isPatRefresh("some-refresh-token|user|machine")).toBe(false);
    expect(isPatRefresh("")).toBe(false);
  });

  it("exports the expected prefixes", () => {
    expect(PAT_REFRESH_PREFIX).toBe("pat");
    expect(JRT_REFRESH_PREFIX).toBe("jrt");
  });
});
