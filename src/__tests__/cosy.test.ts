import { describe, expect, it } from "vitest";
import {
  getQoderBaseUrl,
  getQoderCenterUrl,
  getQoderChatURL,
  getQoderCNDirectModel,
  getQoderCNFriendlyModelInfo,
  getQoderExchangeURL,
  getQoderGlobalDirectModel,
  getQoderManageUrl,
  getQoderModelListURL,
  getQoderOpenApiUrl,
  getQoderRefreshURL,
  getQoderUsageURL,
  getQoderUserEmailFallback,
  getQoderUserInfoURL,
  toQoderCNFriendlyModel,
  toQoderGlobalFriendlyModel,
} from "../cosy.js";

describe("getQoderBaseUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderBaseUrl("cn")).toBe("https://gateway.qoder.com.cn/");
  });
  it("returns global URL for global mode", () => {
    expect(getQoderBaseUrl("global")).toBe("https://api3.qoder.sh/");
  });
});

describe("getQoderOpenApiUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderOpenApiUrl("cn")).toBe("https://openapi.qoder.com.cn");
  });
  it("returns global URL for global mode", () => {
    expect(getQoderOpenApiUrl("global")).toBe("https://openapi.qoder.sh");
  });
});

describe("getQoderCenterUrl", () => {
  it("returns CN URL for cn mode", () => {
    expect(getQoderCenterUrl("cn")).toBe("https://gateway.qoder.com.cn");
  });
  it("returns global URL for global mode", () => {
    expect(getQoderCenterUrl("global")).toBe("https://center.qoder.sh");
  });
});

describe("getQoderModelListURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderModelListURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1");
  });
  it("constructs correct global URL", () => {
    expect(getQoderModelListURL("global")).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
  });
});

describe("getQoderChatURL", () => {
  it("contains base URL and chat path", () => {
    const url = getQoderChatURL("global");
    expect(url).toContain("https://api3.qoder.sh/");
    expect(url).toContain("algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(url).toContain("Encode=1");
  });
});

describe("getQoderExchangeURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderExchangeURL("cn")).toBe("https://openapi.qoder.com.cn/api/v1/jobToken/exchange");
  });
  it("constructs correct global URL", () => {
    expect(getQoderExchangeURL("global")).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
  });
});

describe("getQoderUserInfoURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUserInfoURL("global")).toBe("https://openapi.qoder.sh/api/v1/userinfo");
  });
});

describe("getQoderUsageURL", () => {
  it("constructs correct URL", () => {
    expect(getQoderUsageURL("global")).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
  });
});

describe("getQoderRefreshURL", () => {
  it("constructs correct CN URL", () => {
    expect(getQoderRefreshURL("cn")).toBe("https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token");
  });
  it("constructs correct global URL", () => {
    expect(getQoderRefreshURL("global")).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });
});

describe("getQoderManageUrl", () => {
  it("returns CN URL", () => {
    expect(getQoderManageUrl("cn")).toBe("https://qoder.com.cn");
  });
  it("returns global URL", () => {
    expect(getQoderManageUrl("global")).toBe("https://qoder.com");
  });
});

describe("getQoderUserEmailFallback", () => {
  it("returns CN email", () => {
    expect(getQoderUserEmailFallback("cn")).toBe("user@qoder.com.cn");
  });
  it("returns global email", () => {
    expect(getQoderUserEmailFallback("global")).toBe("user@qoder.com");
  });
});

describe("getQoderCNDirectModel", () => {
  it("maps known model IDs to internal keys", () => {
    expect(getQoderCNDirectModel("qoder-cn")).toBe("auto");
    expect(getQoderCNDirectModel("qwen3.7-max")).toBe("qmodel_latest");
    expect(getQoderCNDirectModel("qwen3.7-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-plus")).toBe("qmodel");
    expect(getQoderCNDirectModel("qwen3.6-flash")).toBe("q36fmodel");
    expect(getQoderCNDirectModel("deepseek-v4-pro")).toBe("dmodel");
    expect(getQoderCNDirectModel("deepseek-v4-flash")).toBe("dfmodel");
    expect(getQoderCNDirectModel("glm-5.2")).toBe("gm51model");
    expect(getQoderCNDirectModel("glm-5.1")).toBe("gm51model");
    expect(getQoderCNDirectModel("kimi-k2.6")).toBe("kmodel");
    expect(getQoderCNDirectModel("minimax-m2.7")).toBe("mmodel");
    expect(getQoderCNDirectModel("minimax-m3")).toBe("mmodel");
  });

  it("returns the input ID for unknown models", () => {
    expect(getQoderCNDirectModel("custom-model")).toBe("custom-model");
  });

  it('defaults to "auto" when no input', () => {
    expect(getQoderCNDirectModel()).toBe("auto");
    expect(getQoderCNDirectModel("")).toBe("auto");
  });
});

describe("getQoderCNFriendlyModelInfo", () => {
  it("returns known friendly info for mapped keys", () => {
    const info = getQoderCNFriendlyModelInfo("qmodel_latest");
    expect(info.id).toBe("qwen3.7-max");
    expect(info.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("returns auto mapping", () => {
    const info = getQoderCNFriendlyModelInfo("auto");
    expect(info.id).toBe("auto");
    expect(info.name).toBe("Auto · Qoder CN");
  });

  it("prettifies model names with version numbers", () => {
    const info = getQoderCNFriendlyModelInfo("some-model", "Qwen3.7-New");
    expect(info.name).toContain("Qwen 3.7");
    expect(info.name).toContain("Qoder CN");
  });
});

describe("toQoderCNFriendlyModel", () => {
  it("maps known model ID to friendly version", () => {
    const result = toQoderCNFriendlyModel({ id: "qmodel_latest", name: "Original Name" });
    expect(result.id).toBe("qwen3.7-max");
    expect(result.name).toBe("Qwen 3.7 Max · Qoder CN");
  });

  it("preserves extra fields", () => {
    const result = toQoderCNFriendlyModel({ id: "auto", name: "Auto", extra: "field" } as {
      id: string;
      name: string;
      extra: string;
    });
    expect(result.extra).toBe("field");
  });
});

describe("getQoderGlobalDirectModel", () => {
  it("maps friendly global IDs back to internal keys", () => {
    expect(getQoderGlobalDirectModel("deepseek-v4-pro")).toBe("dmodel");
    expect(getQoderGlobalDirectModel("deepseek-v4-flash")).toBe("dfmodel");
    expect(getQoderGlobalDirectModel("qwen3.7-max")).toBe("qmodel_latest");
    expect(getQoderGlobalDirectModel("qwen3.7-plus")).toBe("qmodel");
    expect(getQoderGlobalDirectModel("qwen3.8-max")).toBe("qmodel_38max");
    expect(getQoderGlobalDirectModel("kimi-k3")).toBe("kmodel_latest");
    expect(getQoderGlobalDirectModel("kimi-k2.7-code")).toBe("kmodel");
    expect(getQoderGlobalDirectModel("glm-5.3")).toBe("gmodel");
    expect(getQoderGlobalDirectModel("glm-5.2")).toBe("gm51model");
    expect(getQoderGlobalDirectModel("cantus")).toBe("cmodel");
    expect(getQoderGlobalDirectModel("minimax-m3")).toBe("mmodel");
    expect(getQoderGlobalDirectModel("ultimate")).toBe("ultimate");
  });

  it("returns the input ID for unknown models", () => {
    expect(getQoderGlobalDirectModel("custom-model")).toBe("custom-model");
  });

  it('defaults to "auto" when no input', () => {
    expect(getQoderGlobalDirectModel()).toBe("auto");
    expect(getQoderGlobalDirectModel("")).toBe("auto");
  });
});

describe("toQoderGlobalFriendlyModel", () => {
  it("maps dmodel/dfmodel to friendly names", () => {
    expect(toQoderGlobalFriendlyModel({ id: "dfmodel", name: "DeepSeek-V4-Flash" }).id).toBe("deepseek-v4-flash");
    expect(toQoderGlobalFriendlyModel({ id: "dfmodel", name: "DeepSeek-V4-Flash" }).name).toBe("DeepSeek V4 Flash");
    expect(toQoderGlobalFriendlyModel({ id: "dmodel", name: "DeepSeek-V4-Pro" }).id).toBe("deepseek-v4-pro");
    expect(toQoderGlobalFriendlyModel({ id: "dmodel", name: "DeepSeek-V4-Pro" }).name).toBe("DeepSeek V4 Pro");
  });

  it("round-trips friendly id back to internal key", () => {
    const friendly = toQoderGlobalFriendlyModel({ id: "dfmodel", name: "x" });
    expect(getQoderGlobalDirectModel(friendly.id)).toBe("dfmodel");
    const friendly2 = toQoderGlobalFriendlyModel({ id: "dmodel", name: "x" });
    expect(getQoderGlobalDirectModel(friendly2.id)).toBe("dmodel");
  });

  it("passes through unknown models unchanged", () => {
    const result = toQoderGlobalFriendlyModel({ id: "custom-model", name: "Custom" });
    expect(result.id).toBe("custom-model");
    expect(result.name).toBe("Custom");
  });
});
