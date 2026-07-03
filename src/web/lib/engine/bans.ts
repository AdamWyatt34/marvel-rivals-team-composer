import { compose } from "./compose";
import { scoreTeam } from "./scorer";
import { SCORING_PARAMS, type ScoringTables } from "./stats";
import { NoFeasibleTeamError, type TeamRules } from "./types";

/**
 * Greedy adversarial-lite ban suggestions, ported from BanRecommender.
 * The GBDT EnemyImportance shortlist is replaced by a transparent threat
 * score: hero strength + their best matchup edge over our team + community
 * ban consensus.
 */

const TOP_N = 14;

export function threatScore(
  tables: ScoringTables,
  enemyId: string,
  ourIds: readonly string[],
): number {
  const strength = tables.strength.get(enemyId) ?? 0;
  let bestEdge = 0;
  for (const h of ourIds) {
    // enemy's log-odds edge in the (enemy vs our-hero) matchup
    const edge = tables.matchup.get(`${enemyId}|${h}`) ?? 0;
    if (edge > bestEdge) bestEdge = edge;
  }
  const banRate = tables.banRate.get(enemyId) ?? 0;
  return (
    SCORING_PARAMS.K_HERO * strength +
    SCORING_PARAMS.K_MATCHUP * bestEdge +
    0.5 * banRate
  );
}

export function suggestBans(
  tables: ScoringTables,
  myLockedIds: readonly string[],
  enemyLockedIds: readonly string[],
  existingBans: readonly string[],
  rules: TeamRules,
  k = 3,
  mapId?: string | null,
): string[] {
  const banned = new Set(existingBans);
  const chosen: string[] = [];

  const tryCompose = (
    locked: readonly string[],
    enemy: readonly string[],
    bans: Set<string>,
  ) => {
    try {
      return compose(tables, {
        myLockedIds: locked,
        enemyIds: enemy,
        bannedIds: [...bans],
        mapId,
        rules,
      });
    } catch (err) {
      if (err instanceof NoFeasibleTeamError) return null;
      throw err;
    }
  };

  for (let step = 0; step < k; step++) {
    const ours = tryCompose(myLockedIds, enemyLockedIds, banned);
    if (ours == null) break;
    const ourIds = ours.team.map((h) => h.id);
    const ourSet = new Set(ourIds);

    const theirs = tryCompose(enemyLockedIds, ourIds, banned);
    if (theirs == null) break;
    const theirIds = theirs.team.map((h) => h.id);

    const baseline = scoreTeam(tables, ourIds, theirIds, mapId).prob;

    const baseCandidates = [...tables.heroes.keys()].filter(
      (id) => !ourSet.has(id) && !banned.has(id),
    );
    const shortlist = baseCandidates
      .map((id) => ({ id, threat: threatScore(tables, id, ourIds) }))
      .sort((a, b) => b.threat - a.threat)
      .slice(0, TOP_N);
    if (shortlist.length === 0) break;

    let best: string | null = null;
    let bestProb = baseline;
    for (const { id: candidate } of shortlist) {
      const testBans = new Set(banned).add(candidate);
      const ours2 = tryCompose(myLockedIds, enemyLockedIds, testBans);
      if (ours2 == null) continue;
      const our2Ids = ours2.team.map((h) => h.id);
      const theirs2 = tryCompose(enemyLockedIds, our2Ids, testBans);
      if (theirs2 == null) continue;
      const p = scoreTeam(
        tables,
        our2Ids,
        theirs2.team.map((h) => h.id),
        mapId,
      ).prob;
      if (p > bestProb + 1e-9) {
        bestProb = p;
        best = candidate;
      }
    }

    if (best == null) {
      // No recomposition improves us — fall back to raw threat ranking.
      const fallback = shortlist
        .filter((s) => s.threat > 0)
        .slice(0, Math.max(1, k - chosen.length))
        .map((s) => s.id);
      chosen.push(...fallback.filter((id) => !chosen.includes(id)));
      break;
    }

    banned.add(best);
    chosen.push(best);
  }

  return chosen.slice(0, k);
}
