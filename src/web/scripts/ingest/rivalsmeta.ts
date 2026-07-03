import { parseNuxtPage, routeData } from "./devalue-parse";

/**
 * Fetchers for RivalsMeta's two data sources:
 *  - the undocumented JSON stats API (win/pick/ban counts per rank bucket)
 *  - the matchups page, whose SSR payload carries the full hero-vs-hero
 *    matrix for every hero in one load (Diamond+ aggregate)
 *
 * Both are unofficial and may change shape without notice; downstream
 * validation is the contract.
 */

export const USER_AGENT =
  "marvel-rivals-team-composer/1.0 (+https://github.com/AdamWyatt34/marvel-rivals-team-composer; hobby project)";

/** Current season's internal id. Season N maps to internal id 2N (half-seasons increment by 1). */
export const CURRENT_SEASON_ID = 17;

/** Reject data older than this; triggers a probe of the next season id. */
export const MAX_STALENESS_DAYS = 7;

export interface RawHeroTier {
  hero_id: number;
  matches: number;
  wins: number;
  wr_matches: number;
  wr_wins: number;
  mirror_matches: number;
}

export interface RawStats {
  season: number;
  timestamp: number;
  bans: Array<{ rank: string; bans: Array<{ hero_id: number; bans: number }> }>;
  heroes: Array<{ rank: string; heroes: RawHeroTier[] }>;
  maps: Array<{
    hero_id: number;
    total_matches: number;
    maps: Array<{ map_id: number; matches: number; wins: number }>;
  }>;
  teamups: Array<{
    rank: string;
    teamups: Record<
      string,
      {
        matches: number;
        wins: number;
        variants: Record<string, { matches: number; wins: number }>;
      }
    >;
  }>;
}

/** matchups[heroId][enemyHeroId] = hero's games/wins with enemy on the other team */
export type RawMatchups = Record<
  string,
  Record<string, { matches: number; wins: number }>
>;

async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/html",
    },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res;
}

export function isFresh(timestampSeconds: number, now: Date): boolean {
  const ageDays = (now.getTime() / 1000 - timestampSeconds) / 86400;
  return ageDays <= MAX_STALENESS_DAYS;
}

/**
 * Fetches season stats, probing the next season id if the current one has
 * gone stale (season rollover). Returns the payload plus the id that won.
 */
export async function fetchStats(
  now: Date,
  seasonId: number = CURRENT_SEASON_ID,
): Promise<{ stats: RawStats; seasonId: number }> {
  const fetchSeason = async (id: number): Promise<RawStats> =>
    (
      await get(`https://rivalsmeta.com/api/heroes/stats?season=${id}`)
    ).json() as Promise<RawStats>;

  const current = await fetchSeason(seasonId);
  if (isFresh(current.timestamp, now)) return { stats: current, seasonId };

  console.warn(
    `season=${seasonId} data is stale; probing season=${seasonId + 1}`,
  );
  try {
    const next = await fetchSeason(seasonId + 1);
    if (isFresh(next.timestamp, now)) {
      console.warn(
        `season rollover detected: now ingesting season=${seasonId + 1}`,
      );
      return { stats: next, seasonId: seasonId + 1 };
    }
  } catch {
    // fall through to the staleness error below
  }
  throw new Error(
    `RivalsMeta data for season ${seasonId} (and ${seasonId + 1}) is older than ` +
      `${MAX_STALENESS_DAYS} days — refusing to snapshot stale data`,
  );
}

/** One page load returns the matchup tables for every hero. */
export async function fetchMatchups(html?: string): Promise<RawMatchups> {
  const page =
    html ??
    (await (
      await get("https://rivalsmeta.com/characters/thor/matchups")
    ).text());
  const matrix = routeData<RawMatchups>(parseNuxtPage(page));
  const heroIds = Object.keys(matrix);
  if (heroIds.length < 35) {
    throw new Error(
      `Matchup matrix has only ${heroIds.length} heroes — page structure changed?`,
    );
  }
  return matrix;
}

/** [{rank, roles: [{role: "1,1,2,2,3,3", matches, wins}]}] — 1=Vanguard, 2=Duelist, 3=Strategist. */
export type RawTeamComps = Array<{
  rank: string;
  roles: Array<{ role: string; matches: number; wins: number }>;
}>;

export async function fetchTeamComps(html?: string): Promise<RawTeamComps> {
  const page =
    html ?? (await (await get("https://rivalsmeta.com/team-comps")).text());
  const comps = routeData<RawTeamComps>(parseNuxtPage(page));
  if (!Array.isArray(comps) || comps.length === 0) {
    throw new Error(
      "team-comps payload has no rank buckets — page structure changed?",
    );
  }
  return comps;
}

export function seasonLabel(internalId: number): string {
  const n = internalId / 2;
  return Number.isInteger(n) ? `Season ${n}` : `Season ${Math.floor(n)}.5`;
}
