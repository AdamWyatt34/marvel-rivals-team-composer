import { describe, expect, it, vi } from "vitest";
import type { ScoringTables } from "../../lib/engine";
import { NoFeasibleTeamError } from "../../lib/engine";
import { createComposeClient, ComposeAbortedError, type ComposeWorker } from "../compose-client";
import type { WorkerRequest, WorkerResponse } from "../compose-protocol";

vi.mock("../compose-job", () => ({ runComposeJob: vi.fn(() => result), runBansJob: vi.fn(() => []) }));
const result = { primary: [], backups: {}, explanationLines: [], winProbability: 0.5, winProbabilityLow: 0.4, winProbabilityHigh: 0.6 };
const entry = { key: "all", tables: {} as ScoringTables, maps: [] };
const payload = { myLocked: [], enemyLocked: [] };

class StubWorker {
  messages: WorkerRequest[] = [];
  terminate = vi.fn();
  listeners = new Map<string, ((event: { data?: WorkerResponse }) => void)[]>();
  postMessage(message: WorkerRequest) { this.messages.push(message); }
  addEventListener(type: string, listener: (event: { data?: WorkerResponse }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: WorkerResponse) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  reply(id: number) { this.emit("message", { type: "compose", id, result, elapsedMs: 1 }); }
}

function setup() {
  const workers: StubWorker[] = [];
  const client = createComposeClient(() => {
    const worker = new StubWorker();
    workers.push(worker);
    return worker as unknown as ComposeWorker;
  });
  return { client, workers };
}

describe("compose client", () => {
  it("aborts, respawns and uploads tables when compose supersedes a solve", async () => {
    const { client, workers } = setup();
    const first = client.compose(entry, payload);
    const rejected = expect(first).rejects.toBeInstanceOf(ComposeAbortedError);
    const second = client.compose(entry, payload);
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[1].messages.map((m) => m.type)).toEqual(["tables", "compose"]);
    workers[0].reply(1);
    workers[1].reply(2);
    await expect(second).resolves.toEqual(result);
  });

  it("queues bans behind compose, keeping only the latest queued bans", async () => {
    const { client, workers } = setup();
    const compose = client.compose(entry, payload);
    const first = client.bans(entry, payload);
    const rejected = expect(first).rejects.toBeInstanceOf(ComposeAbortedError);
    const latest = client.bans(entry, payload);
    await rejected;
    expect(workers[0].messages).toHaveLength(2);
    workers[0].reply(1);
    await compose;
    expect(workers[0].messages.at(-1)).toMatchObject({ type: "bans", id: 3 });
    workers[0].emit("message", { type: "bans", id: 3, result: [], elapsedMs: 1 });
    await expect(latest).resolves.toEqual([]);
  });

  it("still dispatches queued bans when the active compose rejects", async () => {
    const { client, workers } = setup();
    const compose = expect(client.compose(entry, payload)).rejects.toBeInstanceOf(NoFeasibleTeamError);
    const bans = client.bans(entry, payload);
    workers[0].emit("message", { type: "error", id: 1, name: "NoFeasibleTeamError", message: "infeasible" });
    await compose;
    expect(workers[0].messages.at(-1)).toMatchObject({ type: "bans", id: 2 });
    workers[0].emit("message", { type: "bans", id: 2, result: [], elapsedMs: 1 });
    await expect(bans).resolves.toEqual([]);
  });

  it.each(["error", "messageerror"])("settles all jobs on %s and uses direct jobs afterward", async (type) => {
    const { client, workers } = setup();
    const compose = expect(client.compose(entry, payload)).rejects.toThrow(`Compose worker ${type}`);
    const bans = expect(client.bans(entry, payload)).rejects.toThrow(`Compose worker ${type}`);
    workers[0].emit(type);
    await Promise.all([compose, bans]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await expect(client.compose(entry, payload)).resolves.toEqual(result);
    await expect(client.bans(entry, payload)).resolves.toEqual([]);
    expect(workers).toHaveLength(1);
  });

  it("reuploads an unknown key once and ignores stale ids", async () => {
    const { client, workers } = setup();
    const job = client.compose(entry, payload);
    const settled = vi.fn();
    void job.then(settled);
    workers[0].reply(0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    workers[0].emit("message", { type: "error", id: 1, name: "UnknownKeyError", message: "missing" });
    expect(workers[0].messages.map((m) => m.type)).toEqual(["tables", "compose", "tables", "compose"]);
    workers[0].reply(1);
    await expect(job).resolves.toEqual(result);
    const next = expect(client.compose(entry, payload)).rejects.toMatchObject({ name: "UnknownKeyError" });
    const error: WorkerResponse = { type: "error", id: 2, name: "UnknownKeyError", message: "missing" };
    workers[0].emit("message", error);
    workers[0].emit("message", error);
    await next;
    expect(workers[0].messages).toHaveLength(7);
  });

  it("reconstructs NoFeasibleTeamError", async () => {
    const { client, workers } = setup();
    const job = expect(client.compose(entry, payload)).rejects.toBeInstanceOf(NoFeasibleTeamError);
    workers[0].emit("message", { type: "error", id: 1, name: "NoFeasibleTeamError", message: "infeasible" });
    await job;
  });
});
