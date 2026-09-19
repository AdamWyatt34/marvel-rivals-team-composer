import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineOps } from "../../lib/engine";

const init = vi.fn();
vi.mock("../../wasm/rivals_engine", () => ({
  default: init,
  WasmTables: class {},
}));

type Scope = { importScripts?: unknown };

async function freshLoader() {
  vi.resetModules();
  return import("../engine-loader");
}

describe("engine loader", () => {
  beforeEach(() => {
    init.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    delete (globalThis as Scope).importScripts;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never imports the glue outside a browser context", async () => {
    const { loadEngine } = await freshLoader();
    await expect(loadEngine()).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it("resolves null once, logged once, when instantiation fails in a worker context", async () => {
    (globalThis as Scope).importScripts = () => {};
    init.mockRejectedValue(new Error("WebAssembly.instantiate: bad magic"));
    const { loadEngine } = await freshLoader();
    await expect(loadEngine()).resolves.toBeNull();
    await expect(loadEngine()).resolves.toBeNull();
    expect(init).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.info).mock.calls[0][0]).toMatch(/bad magic/);
  });

  it("returns a wasm engine when the glue initialises", async () => {
    (globalThis as Scope).importScripts = () => {};
    init.mockResolvedValue(undefined);
    const { loadEngine } = await freshLoader();
    const engine = await loadEngine();
    expect(engine?.name).toBe("wasm");
    expect(await loadEngine()).toBe(engine);
  });

  it("awaitEngine yields null past the deadline and the engine when it is ready", async () => {
    vi.useFakeTimers();
    const { awaitEngine } = await freshLoader();
    const engine = { name: "wasm" } as EngineOps;
    const never = awaitEngine(() => new Promise(() => {}), 1500);
    vi.advanceTimersByTime(1500);
    await expect(never).resolves.toBeNull();
    await expect(
      awaitEngine(() => Promise.resolve(engine), 1500),
    ).resolves.toBe(engine);
    await expect(
      awaitEngine(() => Promise.reject(new Error("x")), 1500),
    ).resolves.toBeNull();
  });
});
