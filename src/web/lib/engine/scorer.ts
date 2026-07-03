import { SCORING_PARAMS, sigmoid, type ScoringTables } from "./stats";
import type { Contribution, DetailedTeamScore, TeamScore } from "./types";

/**
 * Additive log-odds team scorer:
 *
 *   z = zBar
 *     + K_HERO    * (1/teamSize) * (sum our strength - sum enemy strength)
 *     + K_MATCHUP * norm * sum over (h in T, e in E) of m_he
 *     + K_MAP     * (1/teamSize) * sum our map deltas
 *     + K_TEAMUP  * sum of active team-up bonuses
 *   P(win) = sigmoid(z)
 *
 * Sums divide by the full team size (not the partial size) so a partial team
 * scores below a complete one — the beam search relies on that monotonicity.
 */

const TEAM_SIZE = 6;

export function scoreTeam(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId?: string | null,
): TeamScore {
  const z = zOf(tables, ourIds, enemyIds, mapId ?? null);
  return { prob: sigmoid(z), z };
}

function zOf(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId: string | null,
): number {
  const { K_HERO, K_MATCHUP, K_MAP, K_TEAMUP } = SCORING_PARAMS;
  let z = tables.zBar;

  let strengthSum = 0;
  for (const h of ourIds) strengthSum += tables.strength.get(h) ?? 0;
  for (const e of enemyIds) strengthSum -= tables.strength.get(e) ?? 0;
  z += (K_HERO * strengthSum) / TEAM_SIZE;

  if (enemyIds.length > 0 && ourIds.length > 0) {
    let matchupSum = 0;
    for (const h of ourIds) {
      for (const e of enemyIds)
        matchupSum += tables.matchup.get(`${h}|${e}`) ?? 0;
    }
    const norm = TEAM_SIZE / (ourIds.length * enemyIds.length);
    z += K_MATCHUP * norm * (matchupSum / TEAM_SIZE);
  }

  if (mapId != null) {
    let mapSum = 0;
    for (const h of ourIds) mapSum += tables.mapDelta.get(`${h}|${mapId}`) ?? 0;
    z += (K_MAP * mapSum) / TEAM_SIZE;
  }

  z += K_TEAMUP * teamUpBonus(tables, ourIds).total;
  return z;
}

function teamUpBonus(
  tables: ScoringTables,
  ourIds: readonly string[],
): {
  total: number;
  active: Array<{ name: string; members: string[]; bonus: number }>;
} {
  const ours = new Set(ourIds);
  let total = 0;
  const active: Array<{ name: string; members: string[]; bonus: number }> = [];
  for (const teamUp of tables.teamUps) {
    // variants are sorted most-members-first; take the biggest one present
    const hit = teamUp.variants.find((v) =>
      v.members.every((m) => ours.has(m)),
    );
    if (hit == null) continue;
    total += hit.bonus;
    active.push({ name: teamUp.name, members: hit.members, bonus: hit.bonus });
  }
  return { total, active };
}

/** Same score plus per-term contributions; used for explanations, not the beam. */
export function scoreTeamDetailed(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId?: string | null,
): DetailedTeamScore {
  const { K_HERO, K_MATCHUP, K_MAP, K_TEAMUP } = SCORING_PARAMS;
  const contributions: Contribution[] = [];
  const nameOf = (id: string) => tables.heroes.get(id)?.name ?? id;

  for (const h of ourIds) {
    contributions.push({
      kind: "hero",
      ids: [h],
      label: nameOf(h),
      deltaLogOdds: (K_HERO * (tables.strength.get(h) ?? 0)) / TEAM_SIZE,
    });
  }
  for (const e of enemyIds) {
    contributions.push({
      kind: "enemy",
      ids: [e],
      label: nameOf(e),
      deltaLogOdds: (-K_HERO * (tables.strength.get(e) ?? 0)) / TEAM_SIZE,
    });
  }

  if (enemyIds.length > 0 && ourIds.length > 0) {
    const norm = TEAM_SIZE / (ourIds.length * enemyIds.length);
    for (const h of ourIds) {
      for (const e of enemyIds) {
        const m = tables.matchup.get(`${h}|${e}`) ?? 0;
        if (m === 0) continue;
        contributions.push({
          kind: "matchup",
          ids: [h, e],
          label: `${nameOf(h)} vs ${nameOf(e)}`,
          deltaLogOdds: (K_MATCHUP * norm * m) / TEAM_SIZE,
        });
      }
    }
  }

  if (mapId != null) {
    for (const h of ourIds) {
      const d = tables.mapDelta.get(`${h}|${mapId}`) ?? 0;
      if (d === 0) continue;
      contributions.push({
        kind: "map",
        ids: [h, mapId],
        label: nameOf(h),
        deltaLogOdds: (K_MAP * d) / TEAM_SIZE,
      });
    }
  }

  for (const active of teamUpBonus(tables, ourIds).active) {
    contributions.push({
      kind: "teamup",
      ids: active.members,
      label: active.name,
      deltaLogOdds: K_TEAMUP * active.bonus,
    });
  }

  const z =
    tables.zBar + contributions.reduce((sum, c) => sum + c.deltaLogOdds, 0);
  return { prob: sigmoid(z), z, contributions };
}
