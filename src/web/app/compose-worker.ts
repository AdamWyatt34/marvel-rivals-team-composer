import { TS_ENGINE, type EngineOps } from "../lib/engine";
import { runComposeJob, runBansJob } from "./compose-job";
import type { WorkerRequest, WorkerResponse } from "./compose-protocol";

export function createWorkerState() {
  return new Map<string, Extract<WorkerRequest, { type: "tables" }>>();
}

export function handleMessage(
  state: ReturnType<typeof createWorkerState>,
  message: WorkerRequest,
  engine: EngineOps = TS_ENGINE,
): WorkerResponse | undefined {
  if (message.type === "tables") {
    if (!state.has(message.key) && state.size > 32) state.clear();
    state.set(message.key, message);
    return;
  }
  const entry = state.get(message.key);
  if (!entry) {
    return {
      type: "error",
      id: message.id,
      name: "UnknownKeyError",
      message: `Unknown tables: ${message.key}`,
    };
  }
  const mark = `compose-worker:${message.type}:${message.id}`;
  performance.mark(mark);
  const started = performance.now();
  try {
    const { tables, maps } = entry;
    if (message.type === "compose") {
      const result = runComposeJob(tables, maps, message.payload, engine);
      return {
        type: "compose",
        id: message.id,
        result,
        elapsedMs: performance.now() - started,
      };
    }
    const result = runBansJob(tables, message.payload, engine);
    return {
      type: "bans",
      id: message.id,
      result,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    return {
      type: "error",
      id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const measurement = performance.measure(
      `compose-worker:${message.type}`,
      mark,
    );
    performance.clearMarks(mark);
    if (process.env.NODE_ENV !== "production") {
      console.info(
        `[compose-worker] ${message.type} ${measurement.duration.toFixed(0)} ms (band=${message.payload.band ?? "all"}, personal=${message.payload.personal?.length ? "yes" : "no"}, locks=${message.payload.myLocked.length}, engine=${engine.name})`,
      );
    }
  }
}

/**
 * Gates the worker's message stream on the engine load: messages that arrive
 * before it settles (or before the deadline) are queued and answered in order
 * with whatever engine is ready then, TS if the load has not landed. A load
 * that lands after the deadline still upgrades every later message — the
 * worker is long-lived, so the deadline only releases the queue, never
 * decides the engine for good.
 */
export function createWorkerEntry({
  state = createWorkerState(),
  engine,
  handle = handleMessage,
  deadlineMs = 1500,
}: {
  state?: ReturnType<typeof createWorkerState>;
  engine: Promise<EngineOps | null>;
  handle?: typeof handleMessage;
  deadlineMs?: number;
}) {
  let ready: EngineOps | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loaded = engine
    .then(
      (result) => (ready = result ?? TS_ENGINE),
      () => (ready = TS_ENGINE),
    )
    .finally(() => clearTimeout(timer));
  const released = Promise.race([
    loaded,
    new Promise<EngineOps>((resolve) => {
      timer = setTimeout(() => resolve((ready ??= TS_ENGINE)), deadlineMs);
    }),
  ]);
  return {
    onMessage(message: WorkerRequest): Promise<WorkerResponse | undefined> {
      if (ready) return Promise.resolve(handle(state, message, ready));
      return released.then(() => handle(state, message, ready ?? TS_ENGINE));
    },
  };
}
