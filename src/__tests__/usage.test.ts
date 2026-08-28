import { afterEach, describe, expect, it, vi } from "vitest";
import { checkQoderQuota, resetQoderQuotaCache } from "../usage.js";

function quotaBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    isQuotaExceeded: false,
    userQuota: { total: 3000, used: 0, remaining: 3000, percentage: 0, unit: "credits" },
    orgResourcePackage: { total: 100, used: 0, remaining: 100, percentage: 0, unit: "credits" },
    upgradeUrl: "https://qoder.com/pricing",
    ...overrides,
  });
}

describe("checkQoderQuota", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetQoderQuotaCache();
    vi.restoreAllMocks();
  });

  function mockQuota(body: string): typeof fetch {
    return vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
  }

  it("flags exhaustion when isQuotaExceeded is true", async () => {
    globalThis.fetch = mockQuota(
      quotaBody({
        isQuotaExceeded: true,
        userQuota: { total: 3000, used: 3000, remaining: 0, percentage: 1, unit: "credits" },
        orgResourcePackage: { total: 100, used: 100, remaining: 0, percentage: 1, unit: "credits" },
      }),
    );
    const result = await checkQoderQuota("token", "global");
    expect(result.exhausted).toBe(true);
    expect(result.message).toMatch(/额度已用完/);
  });

  it("flags exhaustion when both buckets are empty even without isQuotaExceeded", async () => {
    globalThis.fetch = mockQuota(
      quotaBody({
        isQuotaExceeded: false,
        userQuota: { total: 3000, used: 3000, remaining: 0, percentage: 1, unit: "credits" },
        orgResourcePackage: { total: 100, used: 100, remaining: 0, percentage: 1, unit: "credits" },
      }),
    );
    const result = await checkQoderQuota("token", "global");
    expect(result.exhausted).toBe(true);
  });

  it("passes when the org resource package still has credits", async () => {
    globalThis.fetch = mockQuota(
      quotaBody({
        userQuota: { total: 3000, used: 3000, remaining: 0, percentage: 1, unit: "credits" },
        orgResourcePackage: { total: 100, used: 0, remaining: 100, percentage: 0, unit: "credits" },
      }),
    );
    const result = await checkQoderQuota("token", "global");
    expect(result.exhausted).toBe(false);
  });

  it("caches a non-exhausted result for 60s and skips the round-trip", async () => {
    const fetchMock = mockQuota(quotaBody());
    globalThis.fetch = fetchMock;
    await checkQoderQuota("token", "global");
    await checkQoderQuota("token", "global");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks after a cache reset", async () => {
    const fetchMock = mockQuota(quotaBody());
    globalThis.fetch = fetchMock;
    await checkQoderQuota("token", "global");
    resetQoderQuotaCache();
    await checkQoderQuota("token", "global");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never blocks a chat request when the check itself fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const result = await checkQoderQuota("token", "global");
    expect(result.exhausted).toBe(false);
  });
});
