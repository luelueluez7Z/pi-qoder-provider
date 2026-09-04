import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getQoderManageUrl, getQoderMode, getQoderUsageURL, isQoderCNMode } from "./cosy.js";
import { withQoderHttpTimeout } from "./http.js";

interface QoderQuota {
  total: number;
  used: number;
  remaining: number;
  percentage: number;
  unit: string;
}

interface QoderUsageInfo {
  userQuota: QoderQuota;
  orgResourcePackage: QoderQuota;
  totalUsagePercentage: number;
  isQuotaExceeded: boolean;
  expiresAt: number;
  upgradeUrl?: string;
}

export interface QoderProviderUsage {
  summary?: string;
  subscriptionTitle?: string;
  resetAt?: string;
  manageUrl?: string;
  usageBuckets?: Array<{
    id: string;
    label: string;
    usedDisplay: string;
    limitDisplay?: string;
    unit?: string;
    resetAt?: string;
  }>;
  raw?: Record<string, unknown>;
}

async function fetchQoderUsageForMode(credentials: OAuthCredentials, mode: string): Promise<QoderProviderUsage> {
  const raw = await withQoderHttpTimeout("usage request", undefined, async (signal) => {
    const response = await fetch(getQoderUsageURL(mode), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": "pi-provider-qoder",
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Qoder usage: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as QoderUsageInfo;
  });
  const usageBuckets = [];

  if (raw.userQuota) {
    usageBuckets.push({
      id: "user-quota",
      label: "User Quota",
      usedDisplay: raw.userQuota.used.toFixed(2),
      limitDisplay: raw.userQuota.total.toFixed(2),
      unit: raw.userQuota.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  if (raw.orgResourcePackage && raw.orgResourcePackage.total > 0) {
    usageBuckets.push({
      id: "org-resource-package",
      label: "Org Resource Package",
      usedDisplay: raw.orgResourcePackage.used.toFixed(2),
      limitDisplay: raw.orgResourcePackage.total.toFixed(2),
      unit: raw.orgResourcePackage.unit,
      resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    });
  }

  const remainingText = raw.userQuota ? `${raw.userQuota.remaining.toFixed(2)} ${raw.userQuota.unit} remaining` : "";

  return {
    summary: remainingText,
    subscriptionTitle: isQoderCNMode(mode) ? "Qoder CN Plan" : "Qoder AI Plan",
    resetAt: raw.expiresAt ? new Date(raw.expiresAt).toISOString() : undefined,
    manageUrl: getQoderManageUrl(mode),
    usageBuckets,
    raw: raw as unknown as Record<string, unknown>,
  };
}

export async function fetchQoderUsage(credentials: OAuthCredentials): Promise<QoderProviderUsage> {
  return fetchQoderUsageForMode(credentials, getQoderMode());
}

export async function fetchQoderUsageCN(credentials: OAuthCredentials): Promise<QoderProviderUsage> {
  return fetchQoderUsageForMode(credentials, "cn");
}

// ---------------------------------------------------------------------------
// Pre-flight quota guard
//
// When the account has no credits left, the upstream answers the chat endpoint
// with HTTP 200 but never streams anything — the turn would hang forever with
// no error. Check the quota endpoint up front and fail fast with a friendly
// message instead.
// ---------------------------------------------------------------------------

let quotaCheckCache: { at: number; mode: string; exhausted: boolean } | null = null;

export interface QoderQuotaCheck {
  exhausted: boolean;
  message?: string;
}

function formatQuotaExhaustedMessage(raw: QoderUsageInfo, mode: string): string {
  const user = raw.userQuota;
  const org = raw.orgResourcePackage;
  const userPart = user && user.remaining <= 0 ? `个人额度已用尽（${user.used}/${user.total} ${user.unit}）` : "";
  const orgPart = org && org.remaining <= 0 ? "组织额度已用尽" : "";
  const details = [userPart, orgPart].filter(Boolean).join("，");
  const resetAt = raw.expiresAt ? new Date(raw.expiresAt).toLocaleString() : undefined;
  const resetPart = resetAt ? `额度将于 ${resetAt} 重置` : "";
  const upgradeUrl = raw.upgradeUrl || getQoderManageUrl(mode);
  const parts = ["Qoder 积分额度已用完", details, resetPart].filter(Boolean);
  return `${parts.join("：")}。请前往 ${upgradeUrl} 升级套餐或充值后重试。`;
}

/**
 * Pre-flight quota check before a chat request. Returns `exhausted: true` with
 * a friendly message when neither the user quota nor the org resource package
 * has credits left.
 *
 * A non-exhausted result is cached for 60s so normal usage does not pay the
 * extra round-trip on every turn; an exhausted result is never cached, so a
 * recharge takes effect on the very next request. Any check failure is treated
 * as "not exhausted" — the check must never block a chat request.
 */
export async function checkQoderQuota(
  access: string,
  mode: string,
  parentSignal?: AbortSignal,
): Promise<QoderQuotaCheck> {
  if (
    quotaCheckCache &&
    quotaCheckCache.mode === mode &&
    !quotaCheckCache.exhausted &&
    Date.now() - quotaCheckCache.at < 60_000
  ) {
    return { exhausted: false };
  }
  try {
    const raw = await withQoderHttpTimeout("quota request", parentSignal, async (signal) => {
      const response = await fetch(getQoderUsageURL(mode), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${access}`,
          Accept: "application/json",
          "User-Agent": "pi-provider-qoder",
        },
        signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as QoderUsageInfo;
    });
    if (!raw) return { exhausted: false };
    const userRemaining = raw.userQuota?.remaining ?? 0;
    const orgRemaining = raw.orgResourcePackage?.remaining ?? 0;
    const exhausted = raw.isQuotaExceeded === true || (userRemaining <= 0 && orgRemaining <= 0);
    quotaCheckCache = { at: Date.now(), mode, exhausted };
    if (!exhausted) return { exhausted: false };
    return { exhausted: true, message: formatQuotaExhaustedMessage(raw, mode) };
  } catch (error) {
    if (parentSignal?.aborted) throw error;
    return { exhausted: false };
  }
}

/** Test helper: clear the pre-flight quota cache. */
export function resetQoderQuotaCache(): void {
  quotaCheckCache = null;
}
