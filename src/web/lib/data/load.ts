import { calibrationSchema, type Calibration } from "./calibration-schema";
import { pairsTableSchema, type PairsTable } from "./pairs-schema";
import { snapshotSchema, type Snapshot } from "./schema";

/**
 * Loads and caches the committed data files. The basePath prefix matters on
 * GitHub Pages where the site lives under /marvel-rivals-team-composer.
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let cached: Promise<Snapshot> | null = null;
let cachedPairs: Promise<PairsTable | null> | null = null;
let cachedCalibration: Promise<Calibration | null> | null = null;

export function loadSnapshot(): Promise<Snapshot> {
  cached ??= fetchSnapshot();
  return cached;
}

/** Optional pair-synergy data; null (never a throw) when missing or invalid. */
export function loadPairs(): Promise<PairsTable | null> {
  cachedPairs ??= fetchPairs();
  return cachedPairs;
}

/** Optional fitted calibration; null (never a throw) when missing or invalid. */
export function loadCalibration(): Promise<Calibration | null> {
  cachedCalibration ??= fetchOptional("calibration.json", calibrationSchema);
  return cachedCalibration;
}

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch(`${BASE_PATH}/data/snapshot.json`);
  if (!res.ok) {
    cached = null; // allow retry
    throw new Error(`Failed to load data snapshot (${res.status})`);
  }
  try {
    return snapshotSchema.parse(await res.json());
  } catch (err) {
    cached = null;
    throw err;
  }
}

async function fetchPairs(): Promise<PairsTable | null> {
  return fetchOptional("pairs.json", pairsTableSchema);
}

async function fetchOptional<T>(
  file: string,
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_PATH}/data/${file}`);
    if (!res.ok) return null;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? (parsed.data ?? null) : null;
  } catch {
    return null;
  }
}
