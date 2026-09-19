import { NoFeasibleTeamError, type EngineOps } from "../lib/engine";
import { runComposeJob, runBansJob, type ComposePayload, type ComposeResponse } from "./compose-job";
import type { WorkerRequest, WorkerResponse } from "./compose-protocol";
import { awaitEngine, engineOrTs, loadEngine } from "./engine-loader";

export type ComposeWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener">;
type Tables = Omit<Extract<WorkerRequest, { type: "tables" }>, "type">;
type Result = ComposeResponse | { id: string; name: string }[];
type Job = {
  type: "compose" | "bans";
  id: number;
  entry: Tables;
  payload: ComposePayload;
  retried: boolean;
  mark: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
};

export class ComposeAbortedError extends Error {
  constructor() {
    super("Compose request superseded");
    this.name = "ComposeAbortedError";
  }
}

export function createComposeClient(
  workerFactory?: () => ComposeWorker,
  engineLoader: () => Promise<EngineOps | null> = () => awaitEngine(loadEngine),
) {
  const factory = workerFactory ?? (() => new Worker(new URL("./compose.worker.ts", import.meta.url), { type: "module" }));
  let disabled = !workerFactory && typeof Worker === "undefined";
  let worker: ComposeWorker | undefined;
  let active: Job | undefined;
  let queued: Job | undefined;
  let nextId = 0;
  const loadedKeys = new Set<string>();
  // Direct-path supersession: while a request waits for the engine, a newer
  // request of the same kind (or any newer compose) makes it obsolete, so it
  // rejects as aborted instead of running an answer nobody will read.
  let directCompose = 0;
  let directBans = 0;

  function terminate() {
    worker?.terminate();
    worker = undefined;
    loadedKeys.clear();
  }

  function rejectJobs(error: Error) {
    for (const job of [active, queued]) {
      if (!job) continue;
      performance.clearMarks(job.mark);
      job.reject(error);
    }
    active = queued = undefined;
  }

  function fail(error: Error) {
    disabled = true;
    rejectJobs(error);
    terminate();
  }

  function post(job: Job) {
    active = job;
    performance.mark(job.mark);
    try {
      if (!worker) {
        const instance = factory();
        worker = instance;
        instance.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
          if (worker !== instance) return;
          const reply = event.data;
          const current = active;
          if (!current || reply.id !== current.id) return;
          if (reply.type === "error" && reply.name === "UnknownKeyError" && !current.retried) {
            current.retried = true;
            loadedKeys.delete(current.entry.key);
            send(current);
            return;
          }
          if (reply.type !== "error" && reply.type !== current.type) return;
          performance.measure(`compose-client:${current.type}`, current.mark);
          performance.clearMarks(current.mark);
          active = undefined;
          if (reply.type === "error") {
            const error = reply.name === "NoFeasibleTeamError"
              ? Object.assign(new NoFeasibleTeamError(), { message: reply.message })
              : Object.assign(new Error(reply.message), { name: reply.name });
            current.reject(error);
          } else {
            current.resolve(reply.result);
          }
          const waiting = queued;
          queued = undefined;
          if (waiting) post(waiting);
        });
        for (const type of ["error", "messageerror"]) {
          instance.addEventListener(type, () => {
            if (worker === instance) fail(new Error(`Compose worker ${type}`));
          });
        }
      }
      send(job);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function send(job: Job) {
    try {
      if (!loadedKeys.has(job.entry.key)) {
        worker!.postMessage({ type: "tables", ...job.entry } satisfies WorkerRequest);
        loadedKeys.add(job.entry.key);
      }
      worker!.postMessage({ type: job.type, id: job.id, key: job.entry.key, payload: job.payload } satisfies WorkerRequest);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function request(type: Job["type"], entry: Tables, payload: ComposePayload): Promise<Result> {
    if (disabled) {
      const compose = type === "compose" ? ++directCompose : directCompose;
      const bans = type === "bans" ? ++directBans : directBans;
      const engine = engineOrTs(await engineLoader());
      if (compose !== directCompose || (type === "bans" && bans !== directBans)) {
        throw new ComposeAbortedError();
      }
      const mark = `compose-client:direct:${type}`;
      performance.mark(mark);
      try {
        return type === "compose"
          ? runComposeJob(entry.tables, entry.maps, payload, engine)
          : runBansJob(entry.tables, payload, engine);
      } finally {
        performance.measure(`compose-client:${type}`, mark);
        performance.clearMarks(mark);
      }
    }
    if (type === "compose" && (active || queued)) {
      rejectJobs(new ComposeAbortedError());
      terminate();
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const job: Job = { type, id, entry, payload, retried: false, mark: `compose-client:${id}`, resolve, reject };
      if (active) {
        queued?.reject(new ComposeAbortedError());
        queued = job;
      } else {
        post(job);
      }
    });
  }

  return {
    compose: (entry: Tables, payload: ComposePayload) => request("compose", entry, payload) as Promise<ComposeResponse>,
    bans: (entry: Tables, payload: ComposePayload) => request("bans", entry, payload) as Promise<{ id: string; name: string }[]>,
  };
}
