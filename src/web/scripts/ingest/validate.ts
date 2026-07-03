import { snapshotSchema, type Snapshot } from "../../lib/data/schema";

/**
 * Sanity gates between "we parsed something" and "we publish it".
 * Any failure throws — the caller must NOT write the snapshot, so the
 * last-good one keeps serving.
 */

const MIN_HEROES = 35;
const HERO_WR_RANGE = [0.3, 0.7] as const;
const GLOBAL_WR_RANGE = [0.48, 0.52] as const;
const MIN_MATCHUP_COVERAGE = 0.9;
/** Ignore tiny samples when range-checking win rates. */
const MIN_SAMPLE = 200;

export function validateSnapshot(
  snapshot: Snapshot,
  previous: Snapshot | null,
): void {
  snapshotSchema.parse(snapshot);
  const failures: string[] = [];

  // Aggregate across every rank bucket for global checks.
  const totals = new Map<string, { wrMatches: number; wrWins: number }>();
  for (const perHero of Object.values(snapshot.stats)) {
    for (const [slug, s] of Object.entries(perHero)) {
      const t = totals.get(slug) ?? { wrMatches: 0, wrWins: 0 };
      t.wrMatches += s.wrMatches;
      t.wrWins += s.wrWins;
      totals.set(slug, t);
    }
  }

  if (totals.size < MIN_HEROES) {
    failures.push(
      `only ${totals.size} heroes have stats (expected >= ${MIN_HEROES})`,
    );
  }

  let allMatches = 0;
  let allWins = 0;
  for (const [slug, t] of totals) {
    allMatches += t.wrMatches;
    allWins += t.wrWins;
    if (t.wrMatches < MIN_SAMPLE) continue;
    const wr = t.wrWins / t.wrMatches;
    if (wr < HERO_WR_RANGE[0] || wr > HERO_WR_RANGE[1]) {
      failures.push(
        `${slug} overall WR ${(wr * 100).toFixed(1)}% outside [30%, 70%]`,
      );
    }
  }

  const globalWr = allWins / allMatches;
  if (globalWr < GLOBAL_WR_RANGE[0] || globalWr > GLOBAL_WR_RANGE[1]) {
    failures.push(
      `global WR ${(globalWr * 100).toFixed(2)}% outside [48%, 52%]`,
    );
  }

  const heroCount = snapshot.heroes.length;
  const expectedPairs = heroCount * (heroCount - 1);
  let pairsWithData = 0;
  for (const row of Object.values(snapshot.matchups)) {
    pairsWithData += Object.values(row).filter((c) => c.matches > 0).length;
  }
  if (pairsWithData < expectedPairs * MIN_MATCHUP_COVERAGE) {
    failures.push(
      `matchup coverage ${pairsWithData}/${expectedPairs} below ${MIN_MATCHUP_COVERAGE * 100}%`,
    );
  }

  // Role shapes: at least one bucket must carry the standard 2-2-2 comp
  // with a meaningful sample, or the team-comps parse silently broke.
  const shapeSample = Object.values(snapshot.roleShapes).reduce(
    (max, perShape) => Math.max(max, perShape["2-2-2"]?.matches ?? 0),
    0,
  );
  if (shapeSample < 1000) {
    failures.push(
      `role-shape data looks broken: best 2-2-2 bucket has only ${shapeSample} matches`,
    );
  }

  if (previous != null) {
    const prevTotal = totalWrMatches(previous);
    if (
      allMatches < prevTotal * 0.5 &&
      previous.season.internalId === snapshot.season.internalId
    ) {
      failures.push(
        `total matches ${allMatches} dropped below half of previous snapshot (${prevTotal})`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Snapshot failed validation:\n  - ${failures.join("\n  - ")}`,
    );
  }
}

function totalWrMatches(snapshot: Snapshot): number {
  let total = 0;
  for (const perHero of Object.values(snapshot.stats)) {
    for (const s of Object.values(perHero)) total += s.wrMatches;
  }
  return total;
}
