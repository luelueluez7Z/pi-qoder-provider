import { describe, expect, it } from "vitest";
import { deriveQoderThinking, getCachedModelConfig, staticCnModels, staticModels, ZERO_COST } from "../models.js";

describe("static model catalogs", () => {
  it("global catalog exposes tier models", () => {
    const ids = staticModels.map((m) => m.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("ultimate");
    expect(ids).toContain("performance");
    expect(ids).toContain("efficient");
    expect(ids).toContain("lite");
  });

  it("global catalog exposes concrete frontier models", () => {
    const ids = staticModels.map((m) => m.id);
    for (const key of ["qmodel", "cmodel", "qmodel_latest", "dmodel", "dfmodel", "gm51model", "kmodel", "mmodel"]) {
      expect(ids).toContain(key);
    }
  });

  it("all global models point at the global gateway", () => {
    for (const m of staticModels) {
      expect(m.baseUrl).toBe("https://api3.qoder.sh/");
      expect(m.provider).toBe("qoder");
      expect(m.api).toBe("qoder-api");
    }
  });

  it("CN catalog uses friendly ids and CN gateway", () => {
    const ids = staticCnModels.map((m) => m.id);
    expect(ids).toContain("auto");
    expect(ids).toContain("qwen3.7-max");
    expect(ids).toContain("deepseek-v4-pro");
    for (const m of staticCnModels) {
      expect(m.baseUrl).toBe("https://gateway.qoder.com.cn/");
      expect(m.provider).toBe("qoder-cn");
    }
  });

  it("cost is zeroed for all models", () => {
    for (const m of [...staticModels, ...staticCnModels]) {
      expect(m.cost).toBe(ZERO_COST);
    }
  });

  it("maxTokens defaults to 32768 everywhere", () => {
    for (const m of [...staticModels, ...staticCnModels]) {
      expect(m.maxTokens).toBe(32768);
    }
  });

  it("DeepSeek V4 models forward upstream is_vl as-is", () => {
    // The plugin intentionally forwards the upstream is_vl flag verbatim:
    // qoder /model/list reports DeepSeek V4 Pro/Flash as is_vl=true, and we
    // do not second-guess it. Static catalogs mirror that so the fallback
    // path stays consistent with the live catalog.
    const dmodel = staticModels.find((m) => m.id === "dmodel");
    const dfmodel = staticModels.find((m) => m.id === "dfmodel");
    expect(dmodel?.input).toEqual(["text", "image"]);
    expect(dfmodel?.input).toEqual(["text", "image"]);
  });

  it("CN DeepSeek V4 models are text-only", () => {
    const pro = staticCnModels.find((m) => m.id === "deepseek-v4-pro");
    const flash = staticCnModels.find((m) => m.id === "deepseek-v4-flash");
    expect(pro?.input).toEqual(["text"]);
    expect(flash?.input).toEqual(["text"]);
  });
});

describe("getCachedModelConfig", () => {
  it("returns null for unknown global models (falls through to stream fallback)", () => {
    // Without a local cache file, unknown global models return null; the stream
    // handler then builds a sensible default config.
    expect(getCachedModelConfig("no-such-model", "global")).toBeNull();
  });

  it("classifies known CN reasoning models", () => {
    const config = getCachedModelConfig("dmodel", "cn");
    expect(config).not.toBeNull();
    expect(config?.is_reasoning).toBe(true);
    expect(config?.max_output_tokens).toBe(32768);
  });

  it("classifies CN non-reasoning models", () => {
    const config = getCachedModelConfig("dfmodel", "cn");
    expect(config).not.toBeNull();
    expect(config?.is_reasoning).toBe(false);
  });
});

describe("deriveQoderThinking", () => {
  it("derives effort surface from thinking_config", () => {
    const thinking = deriveQoderThinking(
      {
        key: "dmodel",
        thinking_config: {
          enabled: {
            efforts: { high: { is_default: true }, max: {} },
          },
        },
      } as Parameters<typeof deriveQoderThinking>[0],
      true,
    );
    expect(thinking).toEqual({ mode: "effort", efforts: ["high", "max"], defaultLevel: "high" });
  });

  it("returns undefined for non-reasoning models", () => {
    expect(deriveQoderThinking({ key: "lite" } as never, false)).toBeUndefined();
  });

  it("returns undefined when no efforts are configured", () => {
    expect(deriveQoderThinking({ key: "x", thinking_config: {} } as never, true)).toBeUndefined();
  });
});
