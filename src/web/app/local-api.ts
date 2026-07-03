import { loadSnapshot } from "../lib/data/load";
import type { Snapshot } from "../lib/data/schema";
import {
  buildBackups,
  buildScoringTables,
  compose,
  DEFAULT_RULES,
  explainTeam,
  suggestBans,
  threatsAgainst,
  type ScoringTables,
  type TierBand,
} from "../lib/engine";

/**
 * Local replacement for the old Azure api-client: same response shapes, but
 * everything is computed in the browser from the committed snapshot.
 */

export type Hero = { id: string; name: string; role: string; tags: string[] };
export type MapItem = { id: string; name: string };

export type ComposePayload = {
  myLocked: string[];
  enemyLocked: string[];
  bans?: string[];
  map?: string;
  band?: TierBand;
};

export type ComposeResponse = {
  primary: { id: string; role: string; name: string }[];
  backups: Record<string, string[]>;
  explanationLines: string[];
  winProbability: number;
};

export type SnapshotMeta = {
  seasonLabel: string;
  updatedAt: string;
};

export type ThreatsResponse = Record<
  string,
  { mult: number; by?: { id: string; name: string; mult: number } }
>;

export type HeroDetails = {
  id: string;
  name: string;
  role: string;
  topCounters: string[];
  topThreats: string[];
  topSynergies: string[];
};

const tablesCache = new Map<TierBand, ScoringTables>();

async function getTables(
  band: TierBand,
): Promise<{ tables: ScoringTables; snapshot: Snapshot }> {
  const snapshot = await loadSnapshot();
  let tables = tablesCache.get(band);
  if (tables == null) {
    tables = buildScoringTables(snapshot, band);
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

  return {
    primary: result.team.map((h) => ({ id: h.id, role: h.role, name: h.name })),
    backups: Object.fromEntries(
      Object.entries(backups).map(([role, ids]) => [role, ids.map(nameOf)]),
    ),
    explanationLines: explanation.lines,
    winProbability: explanation.winProbability,
  };
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

const DETAILS_TOP_N = 5;

export async function getHeroDetails(id: string): Promise<HeroDetails> {
  // Details are informational; the matchup matrix is Diamond+ regardless of band.
  const { tables, snapshot } = await getTables("all");
  const hero = tables.heroes.get(id);
  if (hero == null) throw new Error(`Unknown hero: ${id}`);
  const nameOf = (heroId: string) => tables.heroes.get(heroId)?.name ?? heroId;

  const edges: Array<{ enemy: string; edge: number }> = [];
  for (const other of tables.heroes.keys()) {
    if (other === id) continue;
    const edge = tables.matchup.get(`${id}|${other}`);
    if (edge != null) edges.push({ enemy: other, edge });
  }
  const topCounters = [...edges]
    .sort((a, b) => b.edge - a.edge)
    .slice(0, DETAILS_TOP_N)
    .filter((e) => e.edge > 0)
    .map((e) => nameOf(e.enemy));
  const topThreats = [...edges]
    .sort((a, b) => a.edge - b.edge)
    .slice(0, DETAILS_TOP_N)
    .filter((e) => e.edge < 0)
    .map((e) => nameOf(e.enemy));

  const topSynergies = snapshot.teamUps
    .filter((t) => t.currentlyActive && t.heroes.includes(id))
    .flatMap((t) => t.heroes.filter((h) => h !== id))
    .filter((v, i, all) => all.indexOf(v) === i)
    .slice(0, DETAILS_TOP_N)
    .map(nameOf);

  return {
    id,
    name: hero.name,
    role: hero.role,
    topCounters,
    topThreats,
    topSynergies,
  };
}
