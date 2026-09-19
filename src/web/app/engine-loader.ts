import { createWasmEngine, TS_ENGINE, type EngineOps } from "../lib/engine";

/**
 * Loads the WASM engine once per JS context (the worker and the main thread
 * each instantiate their own copy against the one hashed .wasm asset). Under
 * Node — vitest, the static-export prerender — it resolves null without
 * importing the glue at all: there is no fetch target there, and the TS
 * engine is the answer. Any failure in a browser also resolves null, logged
 * once in dev, so a missing or broken artifact degrades to TS speed, never
 * to a broken compose.
 */

let enginePromise: Promise<EngineOps | null> | undefined;

function inBrowserContext(): boolean {
  return (
    typeof window !== "undefined" ||
    typeof (globalThis as { importScripts?: unknown }).importScripts ===
      "function"
  );
}

function logFallback(reason: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.info(
      `[engine] WASM unavailable, using the TypeScript engine: ${reason}`,
    );
  }
}

/**
 * The bundler rewrites this URL to the hashed asset. Turbopack serves the dev
 * worker from a blob: URL, against which the glue's own root-relative default
 * cannot resolve, so the asset is anchored to the origin explicitly.
 */
function wasmUrl(): URL {
  const asset = new URL("../wasm/rivals_engine_bg.wasm", import.meta.url);
  const origin = (globalThis as { location?: { origin: string } }).location
    ?.origin;
  return origin ? new URL(String(asset), origin) : asset;
}

export function loadEngine(): Promise<EngineOps | null> {
  if (!enginePromise) {
    enginePromise = inBrowserContext()
      ? import("../wasm/rivals_engine")
          .then(async (mod) => {
            await mod.default({ module_or_path: wasmUrl() });
            return createWasmEngine(mod, logFallback);
          })
          .catch((error: unknown) => {
            logFallback(error instanceof Error ? error.message : String(error));
            return null;
          })
      : Promise.resolve(null);
  }
  return enginePromise;
}

/**
 * The engine if it is ready within the deadline, else null so the caller runs
 * TS for this request; a later call still gets the WASM engine once the load
 * lands, because the load itself is memoised. Keeps a stalled cold fetch of the
 * .wasm from holding a request behind a spinner.
 */
export function awaitEngine(
  load: () => Promise<EngineOps | null>,
  deadlineMs = 1500,
): Promise<EngineOps | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), deadlineMs);
    load().then(
      (engine) => {
        clearTimeout(timer);
        resolve(engine);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function engineOrTs(engine: EngineOps | null): EngineOps {
  return engine ?? TS_ENGINE;
}
