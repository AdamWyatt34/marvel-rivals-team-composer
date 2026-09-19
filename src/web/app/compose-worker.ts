import { runComposeJob, runBansJob } from "./compose-job";
import type { WorkerRequest, WorkerResponse } from "./compose-protocol";

export function createWorkerState() {
  return new Map<string, Extract<WorkerRequest, { type: "tables" }>>();
}

export function handleMessage(
  state: ReturnType<typeof createWorkerState>,
  message: WorkerRequest,
): WorkerResponse | undefined {
  if (message.type === "tables") {
    if (!state.has(message.key) && state.size > 32) state.clear();
    state.set(message.key, message);
    return;
  }
  const entry = state.get(message.key);
  if (!entry) {
    return { type: "error", id: message.id, name: "UnknownKeyError", message: `Unknown tables: ${message.key}` };
  }
  const mark = `compose-worker:${message.type}:${message.id}`;
  performance.mark(mark);
  const started = performance.now();
  try {
    const { tables, maps } = entry;
    if (message.type === "compose") {
      const result = runComposeJob(tables, maps, message.payload);
      return { type: "compose", id: message.id, result, elapsedMs: performance.now() - started };
    }
    const result = runBansJob(tables, message.payload);
    return { type: "bans", id: message.id, result, elapsedMs: performance.now() - started };
  } catch (error) {
    return {
      type: "error", id: message.id,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    const measurement = performance.measure(`compose-worker:${message.type}`, mark);
    performance.clearMarks(mark);
    if (process.env.NODE_ENV !== "production") {
      console.info(`[compose-worker] ${message.type} ${measurement.duration.toFixed(0)} ms (band=${message.payload.band ?? "all"}, personal=${message.payload.personal?.length ? "yes" : "no"}, locks=${message.payload.myLocked.length})`);
    }
  }
}
