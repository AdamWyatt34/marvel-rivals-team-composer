import {
  PAIRS_SCHEMA_VERSION,
  type PairsTable,
} from "../../lib/data/pairs-schema";

/**
 * Pure aggregation from sampled comp rows to the pair-count table.
 * Kept separate from the sampler so it's testable and re-runnable with
 * different windows without re-crawling.
 */

/** One sampled match: two 6-hero teams (slugs) and which side won. */
export interface CompRow {
  /** match end, epoch seconds */
  t: number;
  w: "a" | "b";
  a: string[];
  b: string[];
}

export function pairKey(x: string, y: string): string {
  return x < y ? `${x}+${y}` : `${y}+${x}`;
}

export function aggregatePairs(
  rows: readonly CompRow[],
  now: Date,
  windowDays: number,
): PairsTable {
  const cutoff = now.getTime() / 1000 - windowDays * 86400;
  const pairs = new Map<string, { matches: number; wins: number }>();
  let totalMatches = 0;

  for (const row of rows) {
    if (row.t < cutoff) continue;
    if (row.a.length !== 6 || row.b.length !== 6) continue;
    totalMatches++;
    for (const [team, won] of [
      [row.a, row.w === "a"],
      [row.b, row.w === "b"],
    ] as const) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          if (team[i] === team[j]) continue;
          const key = pairKey(team[i], team[j]);
          const agg = pairs.get(key) ?? { matches: 0, wins: 0 };
          agg.matches++;
          if (won) agg.wins++;
          pairs.set(key, agg);
        }
      }
    }
  }

  return {
    schemaVersion: PAIRS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    windowDays,
    totalMatches,
    pairs: Object.fromEntries(
      [...pairs.entries()].sort(([x], [y]) => x.localeCompare(y)),
    ),
  };
}
