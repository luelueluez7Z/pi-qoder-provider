import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildAuthHeaders,
  getQoderBaseUrl,
  getQoderCNFriendlyModelInfo,
  getQoderMode,
  getQoderModelListURL,
  isQoderCNMode,
  logCosyRequest,
  logCosyResponse,
} from "./cosy.js";

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface QoderThinkingDef {
  mode: "effort";
  efforts: string[];
  defaultLevel?: string;
}

/** Shape of a single entry returned by the Qoder /model/list endpoint. */
export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  /** Relative credit multiplier (× the base plan price). 0 = free, 1 = base. */
  price_factor?: number;
  thinking_config?: {
    enabled?: {
      efforts?: Record<string, { description?: string; is_default?: boolean }>;
    };
  };
  source?: string;
  [key: string]: unknown;
}

export interface QoderModelDef {
  id: string;
  name: string;
  api: "qoder-api";
  provider: "qoder" | "qoder-cn";
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  /** Explicit thinking effort surface forwarded to the host (pi thinking levels). */
  thinking?: QoderThinkingDef;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  /** Relative credit multiplier from /model/list (× base plan price). */
  priceFactor?: number;
  description?: string;
}

/**
 * Format a Qoder price factor (relative credit multiplier) for display, e.g.
 * `1` -> " · ×1", `1.6` -> " · ×1.6", `0` -> " · ×0". Returns "" when the
 * factor is unknown so the model name stays clean.
 */
export function formatQoderPriceFactor(pf: number | undefined): string {
  if (pf === undefined || Number.isNaN(pf)) return "";
  const text = Number.isInteger(pf) ? String(pf) : pf.toFixed(2).replace(/\.?0+$/, "");
  return ` · ×${text}`;
}

// ---------------------------------------------------------------------------
// Static fallback catalogs (used when the live catalog is unreachable).
// ---------------------------------------------------------------------------

export const staticModels: QoderModelDef[] = [
  {
    id: "auto",
    name: "Qoder Auto",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
    priceFactor: 1,
  },
  {
    id: "ultimate",
    name: "Qoder Ultimate",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 1.6,
  },
  {
    id: "performance",
    name: "Qoder Performance",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 1.1,
  },
  {
    id: "efficient",
    name: "Qoder Efficient",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
    priceFactor: 0.3,
  },
  {
    id: "lite",
    name: "Qoder Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
    priceFactor: 0,
  },
  {
    id: "qmodel",
    name: "Qwen3.7 Plus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.1,
  },
  {
    id: "cmodel",
    name: "Cantus",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 3.2,
  },
  {
    id: "qmodel_preview",
    name: "Qwen3.8 Max Preview",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.5,
  },
  {
    id: "qfmodel",
    name: "Qwen 3.8 Flash",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["xhigh", "low", "medium"], defaultLevel: "xhigh" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.1,
  },
  {
    id: "qmodel_latest",
    name: "Qwen3.7 Max",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.5,
  },
  {
    id: "dmodel",
    name: "DeepSeek V4 Pro",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.8,
  },
  {
    id: "dfmodel",
    name: "DeepSeek V4 Flash",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.3,
  },
  {
    id: "gm51model",
    name: "GLM 5.2",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: true,
    supportsEffort: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.5,
  },
  {
    id: "kmodel",
    name: "Kimi K2.7 Code",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 32768,
    priceFactor: 0.3,
  },
  {
    id: "kmodel_latest",
    name: "Kimi K3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.8,
  },
  {
    id: "mmodel",
    name: "MiniMax M3",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.2,
  },
];

export const staticCnModels: QoderModelDef[] = [
  {
    id: "auto",
    name: "Auto · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 180000,
    maxTokens: 32768,
    priceFactor: 1,
    description: "Qoder CN smart routing; live catalog reports 180K max input.",
  },
  {
    id: "qwen3.7-max",
    name: "Qwen 3.7 Max · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.5,
    description: "Qoder CN qmodel_latest; context options 200K/400K/1M.",
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen 3.7 Plus · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.1,
    description: "Qoder CN qmodel; context options 200K/400K/1M.",
  },
  {
    id: "qwen3.6-flash",
    name: "Qwen 3.6 Flash · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.1,
    description: "Qoder CN q36fmodel; context options 200K/400K/1M.",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.8,
    description: "Qoder CN dmodel; context options 200K/400K/1M.",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: true,
    thinking: { mode: "effort", efforts: ["high", "max"], defaultLevel: "max" },
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 1000000,
    maxTokens: 32768,
    priceFactor: 0.3,
    description: "Qoder CN dfmodel; context options 200K/400K/1M.",
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2 · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 32768,
    priceFactor: 0.5,
    description: "Qoder CN gm51model; live catalog currently displays GLM-5.2 with 200K context.",
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6 · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: true,
    supportsEffort: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 256000,
    maxTokens: 32768,
    priceFactor: 0.3,
    description: "Qoder CN kmodel; context option 256K.",
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7 · Qoder CN",
    api: "qoder-api",
    provider: "qoder-cn",
    baseUrl: getQoderBaseUrl("cn"),
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: 200000,
    maxTokens: 32768,
    priceFactor: 0.2,
    description: "Qoder CN mmodel; live catalog reports 200K context.",
  },
];

// ---------------------------------------------------------------------------
// Local model cache
// ---------------------------------------------------------------------------

function getQoderCachePath(mode?: string): string {
  return join(
    homedir(),
    ".pi",
    "agent",
    isQoderCNMode(mode) ? "qoder-cn-models-cache.json" : "qoder-models-cache.json",
  );
}

/**
 * Forward the upstream thinking effort surface (e.g. `high`/`max` for
 * DeepSeek V4) as explicit model metadata so the host offers exactly the
 * wire-supported levels instead of inferring a generic fallback ladder.
 */
export function deriveQoderThinking(entry: QoderModelEntry, isReasoning: boolean): QoderThinkingDef | undefined {
  if (!isReasoning) return undefined;
  const effortsObj = entry.thinking_config?.enabled?.efforts;
  if (!effortsObj || typeof effortsObj !== "object") return undefined;
  const efforts = Object.keys(effortsObj);
  if (efforts.length === 0) return undefined;
  const defaultEffort = Object.entries(effortsObj).find(([, cfg]) => cfg?.is_default)?.[0];
  return {
    mode: "effort",
    efforts,
    ...(defaultEffort ? { defaultLevel: defaultEffort } : {}),
  };
}

/**
 * Build a pi `thinkingLevelMap` from the qoder-supplied effort surface.
 *
 * `off` is always available (maps to qoder `"none"`). For every pi level that
 * qoder actually exposes (from `thinking_config.enabled.efforts`, e.g.
 * `["high","max"]` for DeepSeek V4), map it to its qoder wire value; levels
 * qoder does not support are set to `null` so the host hides them. This makes
 * the /model selector show exactly what qoder returns (off / high / max), not
 * a generic pi ladder.
 */
export function qoderThinkingLevelMap(m: QoderModelDef): Record<string, string | null> {
  const def = m.thinking;
  if (!def) return {};
  const efforts = new Set(def.efforts);
  // pi level -> qoder wire value (same name, except "off" -> "none")
  const piLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const map: Record<string, string | null> = { off: "none" };
  for (const level of piLevels) {
    map[level] = efforts.has(level) ? level : null;
  }
  return map;
}

export function getCachedModels(mode?: string): QoderModelDef[] {
  const cachePath = getQoderCachePath(mode);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      if (data && Array.isArray(data.models)) return data.models;
    } catch {}
  }
  return isQoderCNMode(mode) ? staticCnModels : staticModels;
}

export function getCachedModelConfig(modelKey: string, mode?: string): QoderModelEntry | null {
  const cachePath = getQoderCachePath(mode);
  if (existsSync(cachePath)) {
    try {
      const data = JSON.parse(readFileSync(cachePath, "utf8"));
      if (data?.configs?.[modelKey]) {
        return withMaxContextAsDefault(data.configs[modelKey] as QoderModelEntry);
      }
    } catch {}
  }

  if (isQoderCNMode(mode)) {
    const reasoningModels = new Set([
      "qoder-cn",
      "auto",
      "qmodel_latest",
      "qmodel",
      "q36fmodel",
      "qfmodel",
      "dmodel",
      "gm51model",
      "kmodel",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.6-flash",
      "deepseek-v4-pro",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.6",
    ]);
    return {
      key: modelKey,
      is_reasoning: reasoningModels.has(modelKey),
      max_output_tokens: 32768,
      source: "system",
    };
  }

  return null;
}

/** Prefer the largest context option when Qoder exposes selectable contexts. */
function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;

  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;

  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function isCacheStale(mode?: string): boolean {
  const cachePath = getQoderCachePath(mode);
  if (!existsSync(cachePath)) return true;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!data || typeof data.updatedAt !== "number") return true;
    return Date.now() - data.updatedAt > 3600_000; // stale if older than 1 hour
  } catch {
    return true;
  }
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  mode: string = getQoderMode(),
): Promise<void> {
  const modelListURL = getQoderModelListURL(mode);
  try {
    const headers = buildAuthHeaders(null, modelListURL, { userID, authToken, name, email });
    logCosyRequest("GET", modelListURL, headers);

    const response = await fetch(modelListURL, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
    });
    await logCosyResponse(modelListURL, response);
    if (!response.ok) return;

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable) continue;

      const display = entry.display_name || key;
      let ctxLen = entry.max_input_tokens || 180000;
      if (entry.context_config && typeof entry.context_config === "object") {
        for (const configVal of Object.values(entry.context_config)) {
          if (configVal && typeof configVal === "object" && typeof configVal.token_count === "number") {
            if (configVal.token_count > ctxLen) ctxLen = configVal.token_count;
          }
        }
      }

      const isVL = !!entry.is_vl;
      const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
      const supportsEffort = !!entry.thinking_config?.enabled?.efforts;
      const thinking = deriveQoderThinking(entry, isReasoning);
      const priceFactor = typeof entry.price_factor === "number" ? entry.price_factor : undefined;
      const modelInfo = isQoderCNMode(mode) ? getQoderCNFriendlyModelInfo(key, display) : { id: key, name: display };

      configs[key] = entry;
      if (modelInfo.id !== key) configs[modelInfo.id] = entry;

      newModels.push({
        id: modelInfo.id,
        name: modelInfo.name,
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: isReasoning,
        supportsEffort,
        thinking,
        input: isVL ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: ctxLen,
        maxTokens: entry.max_output_tokens || 32768,
        ...(priceFactor !== undefined ? { priceFactor } : {}),
      });
    }

    // Ensure auto is present.
    if (!newModels.some((m) => m.id === "auto")) {
      newModels.unshift({
        id: "auto",
        name: isQoderCNMode(mode) ? "Auto · Qoder CN" : "Qoder Auto",
        api: "qoder-api",
        provider: isQoderCNMode(mode) ? "qoder-cn" : "qoder",
        baseUrl: getQoderBaseUrl(mode),
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 180000,
        maxTokens: 32768,
        priceFactor: 1,
      });
    }

    if (newModels.length === 0) return;

    const cacheData = { updatedAt: Date.now(), models: newModels, configs };
    const cachePath = getQoderCachePath(mode);
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");
  } catch {}
}
