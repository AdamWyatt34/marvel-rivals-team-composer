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
  /** snapshot map id; absent in rows sampled before map capture */
  m?: string;
}

export function pairKey(x: string, y: string): string {
  return x < y ? `${x}+${y}` : `${y}+${x}`;
}

/**
 * Balance patches invalidate old comps overnight, so matches decay with a
 * half-life instead of counting fully until a hard cutoff. windowDays stays
 * as the guard beyond which rows are dropped entirely (~4 half-lives).
 */
const HALF_LIFE_DAYS = 21;

export function aggregatePairs(
  rows: readonly CompRow[],
  now: Date,
  windowDays: number,
): PairsTable {
  const nowEpoch = now.getTime() / 1000;
  const cutoff = nowEpoch - windowDays * 86400;
  const pairs = new Map<string, { matches: number; wins: number }>();
  const counters = new Map<string, { matches: number; wins: number }>();
  let totalMatches = 0;

  for (const row of rows) {
    if (row.t < cutoff) continue;
    if (row.a.length !== 6 || row.b.length !== 6) continue;
    totalMatches++;
    const ageDays = Math.max(0, (nowEpoch - row.t) / 86400);
    const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    for (const [team, opp, won] of [
      [row.a, row.b, row.w === "a"],
      [row.b, row.a, row.w === "b"],
    ] as const) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          if (team[i] === team[j]) continue;
          const key = pairKey(team[i], team[j]);
          const agg = pairs.get(key) ?? { matches: 0, wins: 0 };
          agg.matches += weight;
          if (won) agg.wins += weight;
          pairs.set(key, agg);
        }
      }
      for (const x of team) {
        for (const y of opp) {
          if (x === y) continue; // mirror picks carry no counter signal
          const key = `${x}|${y}`;
          const agg = counters.get(key) ?? { matches: 0, wins: 0 };
          agg.matches += weight;
          if (won) agg.wins += weight;
          counters.set(key, agg);
        }
      }
    }
  }

  const round = (x: number) => Math.round(x * 1000) / 1000;
  const sorted = (m: Map<string, { matches: number; wins: number }>) =>
    Object.fromEntries(
      [...m.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => [
          k,
          { matches: round(v.matches), wins: round(v.wins) },
        ]),
    );
  return {
    schemaVersion: PAIRS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    windowDays,
    totalMatches,
    pairs: sorted(pairs),
    counters: sorted(counters),
  };
}
