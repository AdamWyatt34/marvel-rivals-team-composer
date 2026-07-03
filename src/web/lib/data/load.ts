import { snapshotSchema, type Snapshot } from "./schema";

/**
 * Loads and caches the committed snapshot. The basePath prefix matters on
 * GitHub Pages where the site lives under /marvel-rivals-team-composer.
 */

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let cached: Promise<Snapshot> | null = null;

export function loadSnapshot(): Promise<Snapshot> {
  cached ??= fetchSnapshot();
  return cached;
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
