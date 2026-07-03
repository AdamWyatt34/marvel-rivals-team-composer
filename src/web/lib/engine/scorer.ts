import { SCORING_PARAMS, sigmoid, type ScoringTables } from "./stats";
import type { Contribution, DetailedTeamScore, TeamScore } from "./types";

/**
 * Additive log-odds team scorer:
 *
 *   z = zBar
 *     + K_HERO     * (1/teamSize) * (sum our strength - sum enemy strength)
 *     + K_MATCHUP  * (|E|/6 * mean known-pair m_he  +  (6-|E|)/6 * mean field edge)
 *     + K_MAP      * (1/teamSize) * sum our map deltas
 *     + K_TEAMUP   * sum of active team-up bonuses
 *     + K_SHAPE    * role-shape delta (complete teams only)
 *     + K_COVERAGE * mean of coverage gaps vs likely threats (<= 0)
 *   P(win) = sigmoid(z)
 *
 * Sums divide by the full team size (not the partial size) so a partial team
 * scores below a complete one — the beam search relies on that monotonicity.
 * The coverage penalty also shrinks as the team grows (max over more heroes),
 * which preserves the same property.
 */

const TEAM_SIZE = 6;
const FULL_TEAM_PAIRS = (TEAM_SIZE * (TEAM_SIZE - 1)) / 2; // 15

function pairSynergySum(
  tables: ScoringTables,
  ourIds: readonly string[],
): number {
  if (tables.pairSynergy.size === 0 || ourIds.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < ourIds.length; i++) {
    for (let j = i + 1; j < ourIds.length; j++) {
      const [x, y] =
        ourIds[i] < ourIds[j] ? [ourIds[i], ourIds[j]] : [ourIds[j], ourIds[i]];
      sum += tables.pairSynergy.get(`${x}+${y}`) ?? 0;
    }
  }
  return sum;
}

export function scoreTeam(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId?: string | null,
  bannedIds: readonly string[] = [],
): TeamScore {
  const z = zOf(tables, ourIds, enemyIds, mapId ?? null, bannedIds);
  return { prob: sigmoid(z), z };
}

function zOf(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId: string | null,
  bannedIds: readonly string[],
): number {
  const { K_HERO, K_MATCHUP, K_MAP, K_TEAMUP, K_SHAPE, K_COVERAGE } =
    SCORING_PARAMS;
  let z = tables.zBar;

  let strengthSum = 0;
  for (const h of ourIds) strengthSum += tables.strength.get(h) ?? 0;
  for (const e of enemyIds) strengthSum -= tables.strength.get(e) ?? 0;
  z += (K_HERO * strengthSum) / TEAM_SIZE;

  // Matchup term: known enemies fill |E| of the 6 enemy slots; the rest are
  // filled with the field expectation (pick-probability-weighted matchup edge
  // vs the band's likely meta, bans and known picks excluded). Heroes that
  // farm the actual meta therefore outrank heroes that only beat off-meta
  // picks even before the enemy locks anything.
  if (ourIds.length > 0) {
    let matchupTerm = 0;
    if (enemyIds.length > 0) {
      let matchupSum = 0;
      for (const h of ourIds) {
        for (const e of enemyIds)
          matchupSum += tables.matchup.get(`${h}|${e}`) ?? 0;
      }
      matchupTerm +=
        (enemyIds.length / TEAM_SIZE) *
        (matchupSum / (ourIds.length * enemyIds.length));
    }
    if (enemyIds.length < TEAM_SIZE && tables.fieldMatchup.size > 0) {
      const excluded = new Set([...bannedIds, ...enemyIds]);
      let fieldSum = 0;
      for (const h of ourIds) fieldSum += fieldEdge(tables, h, excluded);
      matchupTerm +=
        ((TEAM_SIZE - enemyIds.length) / TEAM_SIZE) *
        (fieldSum / ourIds.length);
    }
    z += K_MATCHUP * matchupTerm;
  }

  if (mapId != null) {
    let mapSum = 0;
    for (const h of ourIds) mapSum += tables.mapDelta.get(`${h}|${mapId}`) ?? 0;
    z += (K_MAP * mapSum) / TEAM_SIZE;
  }

  // Team-ups and pair synergies cut both ways: the enemy's active combos
  // lower our win probability just as ours raise it.
  z += K_TEAMUP * teamUpBonus(tables, ourIds).total;
  z -= K_TEAMUP * teamUpBonus(tables, enemyIds).total;
  z += K_SHAPE * (shapeDeltaOf(tables, ourIds) ?? 0);
  z +=
    SCORING_PARAMS.K_PAIR * (pairSynergySum(tables, ourIds) / FULL_TEAM_PAIRS);
  z -=
    SCORING_PARAMS.K_PAIR *
    (pairSynergySum(tables, enemyIds) / FULL_TEAM_PAIRS);

  const gaps = coverageGaps(tables, ourIds, enemyIds, bannedIds);
  if (gaps.length > 0) {
    const totalGap = gaps.reduce((sum, g) => sum + g.gap, 0);
    z += (K_COVERAGE * totalGap) / gaps.length;
  }

  return z;
}

/**
 * Hero's expected matchup edge vs an unknown enemy slot, with the excluded
 * heroes (bans + known enemy picks) removed from the field distribution and
 * the remainder renormalized. Falls back to 0 if exclusions eat almost the
 * whole field.
 */
function fieldEdge(
  tables: ScoringTables,
  heroId: string,
  excluded: ReadonlySet<string>,
): number {
  let edge = tables.fieldMatchup.get(heroId) ?? 0;
  let excludedShare = 0;
  for (const x of excluded) {
    const share = tables.fieldShare.get(x) ?? 0;
    if (share === 0) continue;
    excludedShare += share;
    // mirror matchup (x === heroId) is neutral, so only the share moves
    if (x !== heroId)
      edge -= share * (tables.matchup.get(`${heroId}|${x}`) ?? 0);
  }
  const remaining = 1 - excludedShare;
  return remaining > 0.05 ? edge / remaining : 0;
}

/** Role-shape delta for complete teams; null for partial teams or unknown shapes. */
function shapeDeltaOf(
  tables: ScoringTables,
  ourIds: readonly string[],
): number | null {
  if (ourIds.length !== TEAM_SIZE) return null;
  const counts = { Vanguard: 0, Duelist: 0, Strategist: 0 };
  for (const id of ourIds) {
    const hero = tables.heroes.get(id);
    if (hero == null) return null;
    counts[hero.role]++;
  }
  const key = `${counts.Vanguard}-${counts.Duelist}-${counts.Strategist}`;
  return tables.shapeDelta.get(key) ?? null;
}

/**
 * Coverage gaps: for each likely threat, the team's best matchup edge into
 * it. Negative best edge = nobody answers that threat. Threats are the
 * enemy's known picks plus the band's meta staples (excluding banned heroes),
 * so the term works before the enemy has locked anything.
 */
function coverageGaps(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  bannedIds: readonly string[],
): Array<{ threat: string; gap: number }> {
  if (ourIds.length === 0) return [];
  const banned = new Set(bannedIds);
  const threats = new Set(enemyIds);
  for (const t of tables.metaThreats) {
    if (threats.size >= SCORING_PARAMS.META_THREAT_COUNT) break;
    if (!banned.has(t)) threats.add(t);
  }

  const gaps: Array<{ threat: string; gap: number }> = [];
  for (const threat of threats) {
    let best = -Infinity;
    for (const h of ourIds) {
      if (h === threat) {
        best = 0; // we field the hero ourselves; mirror is neutral coverage
        break;
      }
      // Unknown matchups count as neutral — a gap requires every hero's
      // known edge into the threat to be negative.
      const edge = tables.matchup.get(`${h}|${threat}`) ?? 0;
      if (edge > best) best = edge;
    }
    if (best < 0) gaps.push({ threat, gap: best });
  }
  return gaps;
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
  bannedIds: readonly string[] = [],
): DetailedTeamScore {
  const { K_HERO, K_MATCHUP, K_MAP, K_TEAMUP, K_SHAPE, K_COVERAGE } =
    SCORING_PARAMS;
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
    for (const h of ourIds) {
      for (const e of enemyIds) {
        const m = tables.matchup.get(`${h}|${e}`) ?? 0;
        if (m === 0) continue;
        contributions.push({
          kind: "matchup",
          ids: [h, e],
          label: `${nameOf(h)} vs ${nameOf(e)}`,
          deltaLogOdds: (K_MATCHUP * m) / (TEAM_SIZE * ourIds.length),
        });
      }
    }
  }
  if (
    enemyIds.length < TEAM_SIZE &&
    ourIds.length > 0 &&
    tables.fieldMatchup.size > 0
  ) {
    const excluded = new Set([...bannedIds, ...enemyIds]);
    const weight = (TEAM_SIZE - enemyIds.length) / TEAM_SIZE;
    for (const h of ourIds) {
      const edge = fieldEdge(tables, h, excluded);
      if (edge === 0) continue;
      contributions.push({
        kind: "field",
        ids: [h],
        label: nameOf(h),
        deltaLogOdds: (K_MATCHUP * weight * edge) / ourIds.length,
      });
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
  for (const active of teamUpBonus(tables, enemyIds).active) {
    contributions.push({
      kind: "teamup",
      ids: active.members,
      label: `Enemy ${active.name}`,
      deltaLogOdds: -K_TEAMUP * active.bonus,
    });
  }

  const shape = shapeDeltaOf(tables, ourIds);
  if (shape != null && shape !== 0) {
    const counts = { Vanguard: 0, Duelist: 0, Strategist: 0 };
    for (const id of ourIds) {
      const hero = tables.heroes.get(id);
      if (hero != null) counts[hero.role]++;
    }
    contributions.push({
      kind: "shape",
      ids: [...ourIds],
      label: `${counts.Vanguard} Vanguard / ${counts.Duelist} Duelist / ${counts.Strategist} Strategist`,
      deltaLogOdds: K_SHAPE * shape,
    });
  }

  const gaps = coverageGaps(tables, ourIds, enemyIds, bannedIds);
  for (const { threat, gap } of gaps) {
    contributions.push({
      kind: "coverage",
      ids: [threat],
      label: nameOf(threat),
      deltaLogOdds: (K_COVERAGE * gap) / gaps.length,
    });
  }

  if (tables.pairSynergy.size > 0) {
    const pushPairs = (ids: readonly string[], sign: 1 | -1) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const [x, y] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const syn = tables.pairSynergy.get(`${x}+${y}`);
          if (syn == null || syn === 0) continue;
          contributions.push({
            kind: "pair",
            ids: [x, y],
            label: `${sign === -1 ? "Enemy " : ""}${nameOf(x)} + ${nameOf(y)}`,
            deltaLogOdds:
              (sign * SCORING_PARAMS.K_PAIR * syn) / FULL_TEAM_PAIRS,
          });
        }
      }
    };
    pushPairs(ourIds, 1);
    pushPairs(enemyIds, -1);
  }

  const z =
    tables.zBar + contributions.reduce((sum, c) => sum + c.deltaLogOdds, 0);
  return { prob: sigmoid(z), z, contributions };
}
