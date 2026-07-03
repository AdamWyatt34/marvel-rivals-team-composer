import type { ScoringTables } from "./stats";

/**
 * Per-hero threat multipliers against a known enemy line-up, replacing the
 * old ThreatsFunction. threat = exp(-m_he) where m_he is the hero's log-odds
 * edge vs the enemy — >1 means the enemy counters this pick, matching the
 * old 1/counter-multiplier semantics the UI's warning dots expect.
 */

export interface ThreatInfo {
  threat: number;
  by: string | null;
}

export function threatsAgainst(
  tables: ScoringTables,
  enemyIds: readonly string[],
): Map<string, ThreatInfo> {
  const result = new Map<string, ThreatInfo>();
  for (const heroId of tables.heroes.keys()) {
    let worst = 1;
    let by: string | null = null;
    for (const enemyId of enemyIds) {
      if (enemyId === heroId) continue;
      const edge = tables.matchup.get(`${heroId}|${enemyId}`) ?? 0;
      const threat = Math.exp(-edge);
      if (threat > worst) {
        worst = threat;
        by = enemyId;
      }
    }
    result.set(heroId, { threat: worst, by });
  }
  return result;
}
