import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestModel = { id: string; name: string; api: string; provider: string };
type TestContext = { model?: { provider?: string }; modelRegistry?: unknown };
type TestHandler = (event: unknown, ctx: TestContext) => unknown;

const mocks = vi.hoisted(() => ({
  mode: "global",
  cnPat: "",
  staleModes: new Set<string>(),
  cachedModels: {} as Record<string, TestModel[]>,
  staticModels: [{ id: "static-global", name: "Static Global", api: "qoder-api", provider: "qoder" }],
  staticCnModels: [{ id: "static-cn", name: "Static CN", api: "qoder-api", provider: "qoder-cn" }],
  credentialsFromPat: vi.fn(),
  interactiveLogin: vi.fn(),
  resolveQoderIdentity: vi.fn(),
  updateQoderModelsCache: vi.fn(),
}));

vi.mock("../cosy.js", () => ({
  getMachineId: () => "test-machine",
  getQoderBaseUrl: (mode: string) => (mode === "cn" ? "https://cn.example/" : "https://global.example/"),
  getQoderCNPat: () => mocks.cnPat,
  getQoderMode: () => mocks.mode,
  getQoderRefreshURL: () => "https://example/refresh",
  getQoderUserEmailFallback: () => "fallback@example.com",
  isQoderCNMode: (mode: string) => mode === "cn",
  toQoderCNFriendlyModel: (model: unknown) => model,
  toQoderGlobalFriendlyModel: (model: unknown) => model,
}));

vi.mock("../models.js", () => ({
  formatQoderPriceFactor: () => "",
  getCachedModels: (mode: string) => mocks.cachedModels[mode] ?? [],
  isCacheStale: (mode: string) => mocks.staleModes.has(mode),
  qoderThinkingLevelMap: () => ({}),
  staticCnModels: mocks.staticCnModels,
  staticModels: mocks.staticModels,
  updateQoderModelsCache: mocks.updateQoderModelsCache,
}));

vi.mock("../login.js", () => ({ interactiveLogin: mocks.interactiveLogin }));

vi.mock("../pat.js", () => ({
  credentialsFromJobTokens: vi.fn(),
  credentialsFromPat: mocks.credentialsFromPat,
  decodePatRefresh: vi.fn(),
  fetchUserInfo: vi.fn(),
  isPatRefresh: vi.fn(),
  refreshJobToken: vi.fn(),
}));

vi.mock("../stream.js", () => ({ streamQoder: vi.fn() }));
vi.mock("../usage.js", () => ({ fetchQoderUsage: vi.fn(), fetchQoderUsageCN: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function writeCredential(access = "existing-access") {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const authPath = join(home, ".pi", "agent", "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      qoder: {
        type: "oauth",
        access,
        refresh: "existing-refresh",
        expires: Date.now() + 60_000,
        userID: "user-existing",
        email: "existing@example.com",
        name: "Existing User",
        machineID: "existing-machine",
      },
    }),
  );
}

function makePi() {
  const handlers: Record<string, TestHandler> = {};
  const registerProvider = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: TestHandler) => {
      handlers[event] = handler;
    }),
    registerProvider,
  };
  return { pi, handlers, registerProvider };
}

function getHandler(handlers: Record<string, TestHandler>, event: string): TestHandler {
  const handler = handlers[event];
  if (!handler) throw new Error(`Missing test handler: ${event}`);
  return handler;
}

let home: string;

beforeEach(() => {
  vi.resetModules();
  mocks.mode = "global";
  mocks.cnPat = "";
  mocks.staleModes.clear();
  mocks.cachedModels = {};
  mocks.credentialsFromPat.mockReset();
  mocks.interactiveLogin.mockReset();
  mocks.resolveQoderIdentity.mockReset();
  mocks.updateQoderModelsCache.mockReset();
  home = mkdtempSync(join(tmpdir(), "qoder-startup-test-"));
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("QODER_API_KEY", "");
  vi.stubEnv("QODER_PERSONAL_ACCESS_TOKEN", "");
  vi.stubEnv("QODER_PAT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

describe("provider startup", () => {
  it("does not await PAT exchange during extension init and gates the first Qoder request", async () => {
    const login = deferred<unknown>();
    mocks.credentialsFromPat.mockReturnValue(login.promise);
    vi.stubEnv("QODER_API_KEY", "test-pat");

    const { default: initialize } = await import("../index.js");
    const { pi, handlers } = makePi();
    await initialize(pi as unknown as ExtensionAPI);

    expect(mocks.credentialsFromPat).toHaveBeenCalledTimes(1);
    expect(handlers.before_agent_start).toBeTypeOf("function");

    const registry = {
      getApiKeyForProvider: vi.fn(async (_providerID: string) => {
        const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
        return auth.qoder?.access;
      }),
      registerProvider: vi.fn(),
    };
    const ctx = { model: { provider: "qoder" }, modelRegistry: registry };
    let gateResolved = false;
    const firstRequestGate = (getHandler(handlers, "before_agent_start")({}, ctx) as Promise<void>).then(() => {
      gateResolved = true;
    });

    await Promise.resolve();
    expect(gateResolved).toBe(false);
    expect(registry.getApiKeyForProvider).not.toHaveBeenCalled();

    login.resolve({
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: Date.now() + 60_000,
      userID: "user-1",
      email: "user@example.com",
      name: "Test User",
      machineID: "machine-1",
    });
    await firstRequestGate;

    expect(gateResolved).toBe(true);
    expect(await registry.getApiKeyForProvider("qoder")).toBe("fresh-access");
  });

  it("lets explicit /login supersede a pending automatic PAT exchange", async () => {
    const startupLogin = deferred<unknown>();
    const manualCredentials = {
      access: "manual-access",
      refresh: "manual-refresh",
      expires: Date.now() + 60_000,
      userID: "manual-user",
      email: "manual@example.com",
      name: "Manual User",
      machineID: "manual-machine",
    };
    mocks.credentialsFromPat.mockReturnValue(startupLogin.promise);
    mocks.interactiveLogin.mockResolvedValue(manualCredentials);
    vi.stubEnv("QODER_API_KEY", "test-pat");

    const { default: initialize } = await import("../index.js");
    const { pi, registerProvider } = makePi();
    await initialize(pi as unknown as ExtensionAPI);
    const qoderConfig = registerProvider.mock.calls.find(([providerID]) => providerID === "qoder")?.[1] as
      | { oauth: { login: (callbacks: unknown) => Promise<{ access: string }> } }
      | undefined;
    if (!qoderConfig) throw new Error("Qoder provider was not registered");

    const result = await qoderConfig.oauth.login({});
    expect(result.access).toBe("manual-access");
    expect(mocks.interactiveLogin).toHaveBeenCalledTimes(1);

    // Simulate Pi persisting the credential returned by its explicit login flow.
    writeCredential("manual-access");
    const { waitForQoderEnvironmentLogin } = await import("../oauth.js");
    await expect(waitForQoderEnvironmentLogin("qoder")).resolves.toBeUndefined();

    // The late startup exchange must not overwrite the explicit login result.
    startupLogin.resolve({
      access: "automatic-access",
      refresh: "automatic-refresh",
      expires: Date.now() + 60_000,
      userID: "automatic-user",
      email: "auto@example.com",
      name: "Automatic User",
      machineID: "automatic-machine",
    });
    await Promise.resolve();
    await Promise.resolve();
    const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
    expect(auth.qoder.access).toBe("manual-access");
  });

  it("returns from session_start immediately and publishes a refreshed catalog in the background", async () => {
    writeCredential();
    const token = deferred<string | undefined>();
    mocks.staleModes.add("global");
    mocks.resolveQoderIdentity.mockResolvedValue({
      access: "existing-access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      userID: "user-2",
      email: "user2@example.com",
      name: "User Two",
      machineID: "machine-2",
    });
    mocks.updateQoderModelsCache.mockImplementation(async (_access, _userID, _name, _email, mode) => {
      mocks.cachedModels[mode as string] = [
        { id: "live-model", name: "Live Model", api: "qoder-api", provider: "qoder" },
      ];
      return true;
    });

    const { default: initialize } = await import("../index.js");
    const { pi, handlers, registerProvider } = makePi();
    await initialize(pi as unknown as ExtensionAPI);
    const registry = {
      getApiKeyForProvider: vi.fn((providerID: string) =>
        providerID === "qoder" ? token.promise : Promise.resolve(undefined),
      ),
      registerProvider,
    };

    const result = getHandler(handlers, "session_start")({}, { modelRegistry: registry });
    expect(result).toBeUndefined();
    expect(registerProvider).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => expect(registry.getApiKeyForProvider).toHaveBeenCalledWith("qoder"));
    token.resolve("existing-access");

    await vi.waitFor(() => {
      expect(registerProvider).toHaveBeenCalledTimes(3);
      const refreshed = registerProvider.mock.calls[2] as [string, { models: TestModel[] }];
      expect(refreshed[0]).toBe("qoder");
      expect(refreshed[1].models.map((model) => model.id)).toContain("live-model");
    });
  });

  it("keeps the existing model registration when background cache refresh fails", async () => {
    writeCredential();
    mocks.staleModes.add("global");
    mocks.resolveQoderIdentity.mockResolvedValue({
      access: "existing-access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      userID: "user-3",
      email: "user3@example.com",
      name: "User Three",
      machineID: "machine-3",
    });
    mocks.updateQoderModelsCache.mockResolvedValue(undefined);

    const { default: initialize } = await import("../index.js");
    const { pi, handlers, registerProvider } = makePi();
    await initialize(pi as unknown as ExtensionAPI);
    const registry = {
      getApiKeyForProvider: vi.fn(async () => "existing-access"),
      registerProvider,
    };

    expect(getHandler(handlers, "session_start")({}, { modelRegistry: registry })).toBeUndefined();
    await vi.waitFor(() => expect(mocks.updateQoderModelsCache).toHaveBeenCalled());

    await vi.waitFor(() => expect(registerProvider).toHaveBeenCalledTimes(3));
    const refreshed = registerProvider.mock.calls[2] as [string, { models: TestModel[] }];
    expect(refreshed[1].models.map((model) => model.id)).toContain("static-global");
  });
});
