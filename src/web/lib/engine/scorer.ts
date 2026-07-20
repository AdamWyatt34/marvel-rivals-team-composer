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

/** Calibrated probability: temperature scales deviation from the base rate. */
export function calibratedProb(tables: ScoringTables, z: number): number {
  return sigmoid(tables.zBar + tables.temperature * (z - tables.zBar));
}

export function scoreTeam(
  tables: ScoringTables,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId?: string | null,
  bannedIds: readonly string[] = [],
): TeamScore {
  const z = zOf(tables, ourIds, enemyIds, mapId ?? null, bannedIds);
  return { prob: calibratedProb(tables, z), z };
}

/**
 * Per-hero cross terms (matchup vs known enemies, field edge, counter sum,
 * map delta) depend only on (hero, enemy set, map, bans) — constant across a
 * whole compose/ban search. One cached row per hero turns ~80 string-keyed
 * lookups per score into 6 array reads. Single-entry cache: the context only
 * changes between user interactions, not within a search.
 */
interface CrossContext {
  key: string;
  perHero: Map<string, [number, number, number, number]>;
}
const crossCache = new WeakMap<ScoringTables, CrossContext>();

function crossTerms(
  tables: ScoringTables,
  h: string,
  enemyIds: readonly string[],
  mapId: string | null,
  bannedIds: readonly string[],
  excluded: ReadonlySet<string>,
): [number, number, number, number] {
  const key = `${enemyIds.join(",")}|${mapId ?? ""}|${bannedIds.join(",")}`;
  let ctx = crossCache.get(tables);
  if (ctx == null || ctx.key !== key) {
    ctx = { key, perHero: new Map() };
    crossCache.set(tables, ctx);
  }
  const hit = ctx.perHero.get(h);
  if (hit != null) return hit;
  let matchupSum = 0;
  let counterSum = 0;
  for (const e of enemyIds) {
    matchupSum += tables.matchup.get(`${h}|${e}`) ?? 0;
    counterSum += tables.counterEdge.get(`${h}|${e}`) ?? 0;
  }
  const field =
    tables.fieldMatchup.size > 0 ? fieldEdge(tables, h, excluded) : 0;
  const mapDelta =
    mapId != null ? (tables.mapDelta.get(`${h}|${mapId}`) ?? 0) : 0;
  const row: [number, number, number, number] = [
    matchupSum,
    field,
    counterSum,
    mapDelta,
  ];
  ctx.perHero.set(h, row);
  return row;
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
  for (const h of ourIds)
    strengthSum +=
      (tables.strength.get(h) ?? 0) + (tables.personalDelta.get(h) ?? 0);
  for (const e of enemyIds) strengthSum -= tables.strength.get(e) ?? 0;
  z += (K_HERO * strengthSum) / TEAM_SIZE;

  if (ourIds.length > 0) {
    const excluded = new Set([...bannedIds, ...enemyIds]);
    let matchupSum = 0;
    let fieldSum = 0;
    let counterSum = 0;
    let mapSum = 0;
    for (const h of ourIds) {
      const [m, f, c, d] = crossTerms(
        tables,
        h,
        enemyIds,
        mapId,
        bannedIds,
        excluded,
      );
      matchupSum += m;
      fieldSum += f;
      counterSum += c;
      mapSum += d;
    }

    // Matchup term: known enemies fill |E| of the 6 enemy slots; the rest
    // are filled with the field expectation (pick-probability-weighted edge
    // vs the band's likely meta, bans and known picks excluded). Heroes that
    // farm the actual meta therefore outrank heroes that only beat off-meta
    // picks even before the enemy locks anything.
    let matchupTerm = 0;
    if (enemyIds.length > 0) {
      matchupTerm +=
        (enemyIds.length / TEAM_SIZE) *
        (matchupSum / (ourIds.length * enemyIds.length));
    }
    if (enemyIds.length < TEAM_SIZE && tables.fieldMatchup.size > 0) {
      matchupTerm +=
        ((TEAM_SIZE - enemyIds.length) / TEAM_SIZE) *
        (fieldSum / ourIds.length);
    }
    z += K_MATCHUP * matchupTerm;

    // Learned counter term: counterEdge("h|e") is directional (h's side vs
    // e's side) and the sample records both orientations, so one direction
    // covers both teams without double counting.
    if (enemyIds.length > 0) {
      z +=
        SCORING_PARAMS.K_COUNTER *
        (enemyIds.length / TEAM_SIZE) *
        (counterSum / (ourIds.length * enemyIds.length));
    }

    if (mapId != null) z += (K_MAP * mapSum) / TEAM_SIZE;
  }

  // Team-ups and pair synergies cut both ways: the enemy's active combos
  // lower our win probability just as ours raise it.
  const ourTotals = sideTotals(tables, ourIds);
  const enemyTotals = sideTotals(tables, enemyIds);
  z += K_TEAMUP * (ourTotals.teamUp - enemyTotals.teamUp);
  z += K_SHAPE * (shapeDeltaOf(tables, ourIds) ?? 0);
  z +=
    (SCORING_PARAMS.K_PAIR * (ourTotals.pairs - enemyTotals.pairs)) /
    FULL_TEAM_PAIRS;

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
  const ctx = threatContext(tables, enemyIds, bannedIds);

  const gaps: Array<{ threat: string; gap: number }> = [];
  for (let ti = 0; ti < ctx.threats.length; ti++) {
    const threat = ctx.threats[ti];
    let best = -Infinity;
    for (const h of ourIds) {
      if (h === threat) {
        best = 0; // we field the hero ourselves; mirror is neutral coverage
        break;
      }
      // Unknown matchups count as neutral — a gap requires every hero's
      // known edge into the threat to be negative.
      const edge = threatEdgeRow(tables, ctx, h)[ti];
      if (edge > best) best = edge;
    }
    if (best < 0) gaps.push({ threat, gap: best });
  }
  return gaps;
}

/** Threat set and per-hero edge rows, cached per (enemy, bans) context —
 * both are constant across a whole compose/ban search. */
interface ThreatContext {
  key: string;
  threats: string[];
  edgeRows: Map<string, number[]>;
}
const threatCache = new WeakMap<ScoringTables, ThreatContext>();

function threatContext(
  tables: ScoringTables,
  enemyIds: readonly string[],
  bannedIds: readonly string[],
): ThreatContext {
  const key = `${enemyIds.join(",")}|${bannedIds.join(",")}`;
  let ctx = threatCache.get(tables);
  if (ctx != null && ctx.key === key) return ctx;
  const banned = new Set(bannedIds);
  const threats = new Set(enemyIds);
  for (const t of tables.metaThreats) {
    if (threats.size >= SCORING_PARAMS.META_THREAT_COUNT) break;
    if (!banned.has(t)) threats.add(t);
  }
  ctx = { key, threats: [...threats], edgeRows: new Map() };
  threatCache.set(tables, ctx);
  return ctx;
}

function threatEdgeRow(
  tables: ScoringTables,
  ctx: ThreatContext,
  h: string,
): number[] {
  let row = ctx.edgeRows.get(h);
  if (row == null) {
    row = ctx.threats.map((t) => tables.matchup.get(`${h}|${t}`) ?? 0);
    ctx.edgeRows.set(h, row);
  }
  return row;
}

function teamUpBonus(
  tables: ScoringTables,
  ourIds: readonly string[],
): {
  total: number;
  active: Array<{ name: string; members: string[]; bonus: number }>;
} {
  // Only team-ups a present hero can trigger are worth checking; the full
  // 100+-entry scan dominated beam-search scoring.
  const candidates = new Set<number>();
  for (const id of ourIds) {
    const idxs = tables.teamUpsByHero.get(id);
    if (idxs != null) for (const idx of idxs) candidates.add(idx);
  }
  const ours = new Set(ourIds);
  let total = 0;
  const active: Array<{ name: string; members: string[]; bonus: number }> = [];
  for (const idx of candidates) {
    const teamUp = tables.teamUps[idx];
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

/**
 * Memoized per-side totals for the terms that depend only on one team's
 * hero set. During a compose the enemy side never changes and beam prefixes
 * repeat, so these hit constantly.
 */
const sideTotalsCache = new WeakMap<
  ScoringTables,
  Map<string, { teamUp: number; pairs: number }>
>();

function sideTotals(
  tables: ScoringTables,
  ids: readonly string[],
): { teamUp: number; pairs: number } {
  let cache = sideTotalsCache.get(tables);
  if (cache == null) {
    cache = new Map();
    sideTotalsCache.set(tables, cache);
  }
  const key = [...ids].sort().join(",");
  const hit = cache.get(key);
  if (hit != null) return hit;
  const value = {
    teamUp: teamUpBonus(tables, ids).total,
    pairs: pairSynergySum(tables, ids),
  };
  if (cache.size > 8192) cache.clear();
  cache.set(key, value);
  return value;
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
    const personal = tables.personalDelta.get(h) ?? 0;
    if (personal !== 0) {
      contributions.push({
        kind: "personal",
        ids: [h],
        label: nameOf(h),
        deltaLogOdds: (K_HERO * personal) / TEAM_SIZE,
      });
    }
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

  if (ourIds.length > 0 && enemyIds.length > 0 && tables.counterEdge.size > 0) {
    const weight = enemyIds.length / TEAM_SIZE;
    for (const h of ourIds) {
      for (const e of enemyIds) {
        const edge = tables.counterEdge.get(`${h}|${e}`) ?? 0;
        if (edge === 0) continue;
        contributions.push({
          kind: "counter",
          ids: [h, e],
          label: `${nameOf(h)} vs ${nameOf(e)}`,
          deltaLogOdds:
            (SCORING_PARAMS.K_COUNTER * weight * edge) /
            (ourIds.length * enemyIds.length),
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
  return { prob: calibratedProb(tables, z), z, contributions };
}
