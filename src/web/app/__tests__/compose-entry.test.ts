import { describe, expect, it, vi } from "vitest";
import { TS_ENGINE, type EngineOps } from "../../lib/engine";
import { createWorkerEntry, createWorkerState, handleMessage } from "../compose-worker";
import type { WorkerRequest } from "../compose-protocol";

const stubEngine = { name: "wasm", compose: vi.fn(), scoreTeam: vi.fn() } as unknown as EngineOps;
const message = (id: number): WorkerRequest => ({ type: "compose", id, key: "all", payload: { myLocked: [], enemyLocked: [] } });

function deferred() {
  let resolve!: (engine: EngineOps | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<EngineOps | null>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("worker entry", () => {
  it("answers messages that arrived before the engine settled, in order, with that engine", async () => {
    const { promise, resolve } = deferred();
    const handle = vi.fn((_state, msg: WorkerRequest, engine: EngineOps) => ({ type: "error" as const, id: msg.type === "tables" ? 0 : msg.id, name: engine.name, message: "" }));
    const entry = createWorkerEntry({ state: createWorkerState(), engine: promise, handle: handle as unknown as typeof handleMessage });
    const first = entry.onMessage(message(1));
    const second = entry.onMessage(message(2));
    expect(handle).not.toHaveBeenCalled();
    resolve(stubEngine);
    await expect(first).resolves.toMatchObject({ id: 1, name: "wasm" });
    await expect(second).resolves.toMatchObject({ id: 2, name: "wasm" });
    expect(handle.mock.calls.map((c) => (c[1] as { id: number }).id)).toEqual([1, 2]);
    await entry.onMessage(message(3));
    expect(handle).toHaveBeenLastCalledWith(expect.anything(), message(3), stubEngine);
  });

  it("falls back to the TypeScript engine when the load yields nothing or fails", async () => {
    const handle = vi.fn((_state, msg: WorkerRequest, engine: EngineOps) => ({ type: "error" as const, id: msg.type === "tables" ? 0 : msg.id, name: engine.name, message: "" }));
    const nothing = createWorkerEntry({ engine: Promise.resolve(null), handle: handle as unknown as typeof handleMessage });
    await expect(nothing.onMessage(message(1))).resolves.toMatchObject({ name: "ts" });
    expect(handle).toHaveBeenLastCalledWith(expect.anything(), message(1), TS_ENGINE);
    const failed = createWorkerEntry({ engine: Promise.reject(new Error("boom")), handle: handle as unknown as typeof handleMessage });
    await expect(failed.onMessage(message(2))).resolves.toMatchObject({ name: "ts" });
  });

  it("reports an unknown key through the real handler once the engine is ready", async () => {
    const entry = createWorkerEntry({ engine: Promise.resolve(stubEngine) });
    await expect(entry.onMessage(message(7))).resolves.toMatchObject({ type: "error", id: 7, name: "UnknownKeyError" });
  });
});

describe("worker entry deadline", () => {
  it("releases queued messages on TypeScript at the deadline and upgrades once the load lands", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (engine: EngineOps | null) => void;
      const engine = new Promise<EngineOps | null>((r) => (resolve = r));
      const handle = vi.fn((_state, msg: WorkerRequest, e: EngineOps) => ({ type: "error" as const, id: msg.type === "tables" ? 0 : msg.id, name: e.name, message: "" }));
      const entry = createWorkerEntry({ engine, handle: handle as unknown as typeof handleMessage, deadlineMs: 100 });
      const early = entry.onMessage(message(1));
      await vi.advanceTimersByTimeAsync(100);
      await expect(early).resolves.toMatchObject({ id: 1, name: "ts" });
      await expect(entry.onMessage(message(2))).resolves.toMatchObject({ id: 2, name: "ts" });
      resolve(stubEngine);
      await vi.advanceTimersByTimeAsync(0);
      await expect(entry.onMessage(message(3))).resolves.toMatchObject({ id: 3, name: "wasm" });
      expect(handle).toHaveBeenLastCalledWith(expect.anything(), message(3), stubEngine);
    } finally {
      vi.useRealTimers();
    }
  });
});
