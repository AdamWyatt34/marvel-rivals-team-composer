import { loadPairs, loadSnapshot } from "../lib/data/load";
import type { Snapshot } from "../lib/data/schema";
import {
  buildBackups,
  buildScoringTables,
  compose,
  DEFAULT_RULES,
  explainTeam,
  scoreTeam,
  SCORING_PARAMS,
  suggestBans,
  threatsAgainst,
  TIER_BANDS,
  type ScoringTables,
  type TierBand,
} from "../lib/engine";

/**
 * Local replacement for the old Azure api-client: same response shapes, but
 * everything is computed in the browser from the committed snapshot.
 */

export type Hero = {
  id: string;
  name: string;
  role: string;
  tags: string[];
  pickShare: number;
  banRate: number;
};
export type MapItem = { id: string; name: string };

export type ComposePayload = {
  myLocked: string[];
  enemyLocked: string[];
  bans?: string[];
  map?: string;
  band?: TierBand;
  /** Restrict non-locked recommendations to these heroes ("my pool only"). */
  poolIds?: string[];
};

export type ComposeResponse = {
  primary: { id: string; role: string; name: string }[];
  backups: Record<string, string[]>;
  explanationLines: string[];
  winProbability: number;
  /** Honest range: sampling variance of the strength terms + model error. */
  winProbabilityLow: number;
  winProbabilityHigh: number;
};

export type SnapshotMeta = {
  seasonLabel: string;
  updatedAt: string;
};

export type ThreatsResponse = Record<
  string,
  { mult: number; by?: { id: string; name: string; mult: number } }
>;

const tablesCache = new Map<TierBand, ScoringTables>();

async function getTables(
  band: TierBand,
): Promise<{ tables: ScoringTables; snapshot: Snapshot }> {
  const [snapshot, pairs] = await Promise.all([loadSnapshot(), loadPairs()]);
  let tables = tablesCache.get(band);
  if (tables == null) {
    tables = buildScoringTables(snapshot, band, pairs);
    tablesCache.set(band, tables);
  }
  return { tables, snapshot };
}

/** S/A/B/C/D from strength quantiles within the band. */
function tierTags(tables: ScoringTables): Map<string, string> {
  const ranked = [...tables.strength.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const tags = new Map<string, string>();
  ranked.forEach((id, i) => {
    const q = (i + 1) / ranked.length;
    const tier =
      q <= 0.1 ? "S" : q <= 0.3 ? "A" : q <= 0.7 ? "B" : q <= 0.9 ? "C" : "D";
    tags.set(id, `tier:${tier}`);
  });
  return tags;
}

export async function getHeroes(band: TierBand = "all"): Promise<Hero[]> {
  const { tables, snapshot } = await getTables(band);
  const tiers = tierTags(tables);
  return snapshot.heroes.map((h) => ({
    id: h.id,
    name: h.name,
    role: h.role,
    tags: [tiers.get(h.id) ?? "tier:D"],
    pickShare: tables.pickShare.get(h.id) ?? 0,
    banRate: tables.banRate.get(h.id) ?? 0,
  }));
}

export async function getMaps(): Promise<MapItem[]> {
  const snapshot = await loadSnapshot();
  return snapshot.maps
    .filter((m) => !m.name.startsWith("Unknown"))
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getThreatsDetailed(
  enemyIds: string[],
  band: TierBand = "all",
): Promise<ThreatsResponse> {
  const { tables } = await getTables(band);
  const threats = threatsAgainst(tables, enemyIds);
  const result: ThreatsResponse = {};
  for (const [heroId, info] of threats) {
    result[heroId] = { mult: info.threat };
    if (info.by != null && info.threat > 1) {
      result[heroId].by = {
        id: info.by,
        name: tables.heroes.get(info.by)?.name ?? info.by,
        mult: info.threat,
      };
    }
  }
  return result;
}

export async function getSnapshotMeta(): Promise<SnapshotMeta> {
  const snapshot = await loadSnapshot();
  return {
    seasonLabel: snapshot.season.label,
    updatedAt: new Date(snapshot.sourceTimestamp * 1000).toISOString(),
  };
}

/** Fast path — runs live on every selection change; no ban search. */
export async function composeTeam(
  payload: ComposePayload,
): Promise<ComposeResponse> {
  const band = payload.band ?? "all";
  const { tables, snapshot } = await getTables(band);
  const banned = payload.bans ?? [];
  const mapId = payload.map || null;

  const result = compose(tables, {
    myLockedIds: payload.myLocked,
    enemyIds: payload.enemyLocked,
    bannedIds: banned,
    mapId,
    rules: DEFAULT_RULES,
    poolIds: payload.poolIds ?? null,
  });
  const teamIds = result.team.map((h) => h.id);

  const backups = buildBackups(
    tables,
    result.team,
    payload.enemyLocked,
    banned,
    DEFAULT_RULES,
    mapId,
  );

  const explanation = explainTeam(
    tables,
    snapshot,
    teamIds,
    payload.enemyLocked,
    mapId,
    banned,
  );
  const nameOf = (id: string) => tables.heroes.get(id)?.name ?? id;

  const { low, high } = probabilityBand(
    tables,
    result.z,
    teamIds,
    payload.enemyLocked,
  );

  return {
    primary: result.team.map((h) => ({ id: h.id, role: h.role, name: h.name })),
    backups: Object.fromEntries(
      Object.entries(backups).map(([role, ids]) => [role, ids.map(nameOf)]),
    ),
    explanationLines: explanation.lines,
    winProbability: explanation.winProbability,
    winProbabilityLow: low,
    winProbabilityHigh: high,
  };
}

/**
 * Uncertainty band: sampling stderr of each hero-strength estimate
 * (2/sqrt(n), the logit-rate variance) propagated through the K_HERO/6
 * weights, plus a fixed model-error floor — the additive model itself is the
 * bigger unknown than sampling noise at these volumes.
 */
const MODEL_SIGMA = 0.08;

function probabilityBand(
  tables: ScoringTables,
  z: number,
  teamIds: readonly string[],
  enemyIds: readonly string[],
): { low: number; high: number } {
  const weight = SCORING_PARAMS.K_HERO / 6;
  let variance = MODEL_SIGMA * MODEL_SIGMA;
  for (const id of [...teamIds, ...enemyIds]) {
    const n = (tables.strengthSamples.get(id) ?? 0) + SCORING_PARAMS.M_HERO;
    const se = weight * (2 / Math.sqrt(n));
    variance += se * se;
  }
  const sigma = Math.sqrt(variance);
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  return { low: sig(z - sigma), high: sig(z + sigma) };
}

/** Slow path — adversarial ban search; invoked from an explicit button. */
export async function suggestBansFor(
  payload: ComposePayload,
): Promise<{ id: string; name: string }[]> {
  const band = payload.band ?? "all";
  const { tables } = await getTables(band);
  const ids = suggestBans(
    tables,
    payload.myLocked,
    payload.enemyLocked,
    payload.bans ?? [],
    DEFAULT_RULES,
    3,
    payload.map || null,
  );
  return ids.map((id) => ({ id, name: tables.heroes.get(id)?.name ?? id }));
}

export type SlotAlternative = { id: string; name: string; deltaProb: number };

/**
 * Same-role alternatives for one slot of a composed team, ranked by the
 * win-probability delta of swapping them in. Powers the what-if UI.
 */
export async function slotAlternatives(
  payload: ComposePayload,
  teamIds: string[],
  slotHeroId: string,
  topN = 5,
): Promise<SlotAlternative[]> {
  const band = payload.band ?? "all";
  const { tables } = await getTables(band);
  const slot = tables.heroes.get(slotHeroId);
  if (slot == null) return [];
  const banned = new Set(payload.bans ?? []);
  const inTeam = new Set(teamIds);
  const mapId = payload.map || null;
  const pool = payload.poolIds != null ? new Set(payload.poolIds) : null;

  const current = scoreTeam(
    tables,
    teamIds,
    payload.enemyLocked,
    mapId,
    payload.bans ?? [],
  ).prob;

  const alternatives: SlotAlternative[] = [];
  for (const hero of tables.heroes.values()) {
    if (hero.role !== slot.role) continue;
    if (inTeam.has(hero.id) || banned.has(hero.id)) continue;
    if (pool != null && !pool.has(hero.id)) continue;
    const mutated = teamIds.map((id) => (id === slotHeroId ? hero.id : id));
    const prob = scoreTeam(
      tables,
      mutated,
      payload.enemyLocked,
      mapId,
      payload.bans ?? [],
    ).prob;
    alternatives.push({
      id: hero.id,
      name: hero.name,
      deltaProb: prob - current,
    });
  }
  return alternatives.sort((a, b) => b.deltaProb - a.deltaProb).slice(0, topN);
}

export type BanBaitWarning = {
  id: string;
  name: string;
  /** Fraction of the band's matches in which this hero is banned. */
  banRate: number;
  backup: SlotAlternative | null;
};

/** Locked heroes likely to be removed in the ban phase get a heads-up. */
const BAN_BAIT_THRESHOLD = 0.2;

/**
 * Bans happen before hero select, so a locked hero with a high ban rate is a
 * plan with a hole in it. For each such lock, surface the rate and the best
 * same-role replacement so the backup plan exists before the ban lands.
 */
export async function getBanBaitWarnings(
  payload: ComposePayload,
  teamIds: string[],
): Promise<BanBaitWarning[]> {
  const band = payload.band ?? "all";
  const { tables } = await getTables(band);
  const banned = new Set(payload.bans ?? []);
  const warnings: BanBaitWarning[] = [];
  for (const id of payload.myLocked) {
    if (banned.has(id)) continue;
    const rate = tables.banRate.get(id) ?? 0;
    if (rate < BAN_BAIT_THRESHOLD) continue;
    const hero = tables.heroes.get(id);
    if (hero == null) continue;
    const alts = teamIds.includes(id)
      ? await slotAlternatives(payload, teamIds, id, 1)
      : [];
    warnings.push({
      id,
      name: hero.name,
      banRate: rate,
      backup: alts[0] ?? null,
    });
  }
  return warnings.sort((a, b) => b.banRate - a.banRate);
}

export type HeroDossier = {
  id: string;
  name: string;
  role: string;
  tier: string;
  winRate: number | null;
  pickShare: number | null;
  banRate: number;
  /** heroes this hero beats hardest (with odds multiplier) */
  beats: Array<{ name: string; edge: number }>;
  /** heroes that beat this hero */
  losesTo: Array<{ name: string; edge: number }>;
  teamUpPartners: string[];
  /** win-rate delta on the selected map, if any */
  mapDelta: number | null;
  /** best pair-synergy partners once sampled data exists */
  pairPartners: Array<{ name: string; synergy: number }>;
};

export async function getHeroDossier(
  id: string,
  band: TierBand = "all",
  mapId?: string | null,
): Promise<HeroDossier> {
  const { tables, snapshot } = await getTables(band);
  const hero = tables.heroes.get(id);
  if (hero == null) throw new Error(`Unknown hero: ${id}`);
  const nameOf = (heroId: string) => tables.heroes.get(heroId)?.name ?? heroId;

  const perTier = Object.values(snapshot.stats);
  let wrMatches = 0;
  let wrWins = 0;
  let matches = 0;
  let totalMatches = 0;
  for (const bucket of perTier) {
    for (const [slug, s] of Object.entries(bucket)) {
      totalMatches += s.matches;
      if (slug === id) {
        wrMatches += s.wrMatches;
        wrWins += s.wrWins;
        matches += s.matches;
      }
    }
  }

  const edges: Array<{ other: string; edge: number }> = [];
  for (const other of tables.heroes.keys()) {
    if (other === id) continue;
    const edge = tables.matchup.get(`${id}|${other}`);
    if (edge != null && edge !== 0) edges.push({ other, edge });
  }
  const beats = [...edges]
    .filter((e) => e.edge > 0)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 3)
    .map((e) => ({ name: nameOf(e.other), edge: e.edge }));
  const losesTo = [...edges]
    .filter((e) => e.edge < 0)
    .sort((a, b) => a.edge - b.edge)
    .slice(0, 3)
    .map((e) => ({ name: nameOf(e.other), edge: e.edge }));

  const teamUpPartners = snapshot.teamUps
    .filter((t) => t.currentlyActive && t.heroes.includes(id))
    .flatMap((t) => t.heroes.filter((h) => h !== id))
    .filter((v, i, all) => all.indexOf(v) === i)
    .map(nameOf);

  const pairPartners: Array<{ name: string; synergy: number }> = [];
  for (const [key, syn] of tables.pairSynergy) {
    const [a, b] = key.split("+");
    if (a !== id && b !== id) continue;
    if (syn <= 0) continue;
    pairPartners.push({ name: nameOf(a === id ? b : a), synergy: syn });
  }
  pairPartners.sort((a, b) => b.synergy - a.synergy).splice(3);

  const heroesList = await getHeroes(band);
  const tier =
    heroesList.find((h) => h.id === id)?.tags[0]?.split(":")[1] ?? "-";

  return {
    id,
    name: hero.name,
    role: hero.role,
    tier,
    winRate: wrMatches > 0 ? wrWins / wrMatches : null,
    pickShare: totalMatches > 0 ? matches / totalMatches : null,
    banRate: tables.banRate.get(id) ?? 0,
    beats,
    losesTo,
    teamUpPartners,
    mapDelta: mapId ? (tables.mapDelta.get(`${id}|${mapId}`) ?? null) : null,
    pairPartners,
  };
}

/* ---------- meta explorer data ---------- */

export type TierListRow = {
  id: string;
  name: string;
  role: string;
  tier: string;
  /** de-biased strength as a WR-equivalent delta vs the band mean */
  adjustedDelta: number;
  rawWinRate: number | null;
  pickShare: number;
  banRate: number;
};

export async function getTierList(band: TierBand): Promise<TierListRow[]> {
  const { tables, snapshot } = await getTables(band);
  const tiers = tierTags(tables);
  const raw = new Map<string, { m: number; w: number }>();
  for (const bucket of Object.values(snapshot.stats)) {
    for (const [slug, s] of Object.entries(bucket)) {
      const agg = raw.get(slug) ?? { m: 0, w: 0 };
      agg.m += s.wrMatches;
      agg.w += s.wrWins;
      raw.set(slug, agg);
    }
  }
  return snapshot.heroes
    .map((h) => {
      const r = raw.get(h.id);
      return {
        id: h.id,
        name: h.name,
        role: h.role,
        tier: tiers.get(h.id)?.split(":")[1] ?? "-",
        // dp/dz at the mean is ~0.25: log-odds delta -> percentage points
        adjustedDelta: (tables.strength.get(h.id) ?? 0) * 0.25,
        rawWinRate: r != null && r.m > 0 ? r.w / r.m : null,
        pickShare: tables.pickShare.get(h.id) ?? 0,
        banRate: tables.banRate.get(h.id) ?? 0,
      };
    })
    .sort((a, b) => b.adjustedDelta - a.adjustedDelta);
}

export type MatchupRow = {
  id: string;
  name: string;
  role: string;
  /** log-odds edge of the selected hero into this one */
  edge: number;
  winRate: number;
  matches: number;
};

export async function getMatchupTable(heroId: string): Promise<MatchupRow[]> {
  const { tables, snapshot } = await getTables("all");
  const row = snapshot.matchups[heroId] ?? {};
  const out: MatchupRow[] = [];
  for (const [other, count] of Object.entries(row)) {
    const hero = tables.heroes.get(other);
    if (hero == null || count.matches === 0) continue;
    out.push({
      id: other,
      name: hero.name,
      role: hero.role,
      edge: tables.matchup.get(`${heroId}|${other}`) ?? 0,
      winRate: count.wins / count.matches,
      matches: count.matches,
    });
  }
  return out.sort((a, b) => b.edge - a.edge);
}

export type TeamUpRow = {
  id: number;
  name: string;
  members: string[];
  variants: Array<{ members: string[]; winRate: number; matches: number }>;
};

export async function getTeamUpStats(band: TierBand): Promise<TeamUpRow[]> {
  const { tables, snapshot } = await getTables(band);
  const nameOf = (id: string) => tables.heroes.get(id)?.name ?? id;
  const codes = TIER_BANDS[band] as readonly string[];

  const rows: TeamUpRow[] = [];
  for (const def of snapshot.teamUps) {
    if (!def.currentlyActive) continue;
    const variantAgg = new Map<string, { m: number; w: number }>();
    for (const code of codes) {
      const bucket = snapshot.teamUpStats[code]?.[String(def.id)];
      if (bucket == null) continue;
      for (const [combo, count] of Object.entries(bucket.variants)) {
        const agg = variantAgg.get(combo) ?? { m: 0, w: 0 };
        agg.m += count.matches;
        agg.w += count.wins;
        variantAgg.set(combo, agg);
      }
    }
    const variants = [...variantAgg.entries()]
      .filter(([, agg]) => agg.m >= 50)
      .map(([combo, agg]) => ({
        members: combo.split("+").map(nameOf),
        winRate: agg.w / agg.m,
        matches: agg.m,
      }))
      .sort((a, b) => b.matches - a.matches);
    if (variants.length === 0) continue;
    rows.push({
      id: def.id,
      name: def.name,
      members: def.heroes.map(nameOf),
      variants,
    });
  }
  return rows.sort(
    (a, b) =>
      b.variants.reduce((s, v) => s + v.matches, 0) -
      a.variants.reduce((s, v) => s + v.matches, 0),
  );
}

export type RoleShapeRow = {
  shape: string;
  label: string;
  matches: number;
  winRate: number;
};

export async function getRoleShapes(band: TierBand): Promise<RoleShapeRow[]> {
  const { snapshot } = await getTables(band);
  const codes = TIER_BANDS[band] as readonly string[];
  const agg = new Map<string, { m: number; w: number }>();
  for (const code of codes) {
    const bucket = snapshot.roleShapes[code];
    if (bucket == null) continue;
    for (const [shape, count] of Object.entries(bucket)) {
      const a = agg.get(shape) ?? { m: 0, w: 0 };
      a.m += count.matches;
      a.w += count.wins;
      agg.set(shape, a);
    }
  }
  return [...agg.entries()]
    .filter(([, a]) => a.m >= 100)
    .map(([shape, a]) => {
      const [v, d, s] = shape.split("-");
      return {
        shape,
        label: `${v} Vanguard / ${d} Duelist / ${s} Strategist`,
        matches: a.m,
        winRate: a.w / a.m,
      };
    })
    .sort((a, b) => b.matches - a.matches);
}
