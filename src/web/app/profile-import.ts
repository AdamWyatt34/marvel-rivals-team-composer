import { loadSnapshot } from "../lib/data/load";

/**
 * Personal profile import: pull a player's current-season competitive
 * history from RivalsMeta's player-match API and derive their hero pool.
 *
 * RivalsMeta sends no CORS headers, so browser calls must go through a
 * forwarding proxy (see infra/rivalsmeta-proxy.js). The feature is hidden
 * unless NEXT_PUBLIC_PROFILE_PROXY is set at build time.
 */

const PROXY = process.env.NEXT_PUBLIC_PROFILE_PROXY ?? "";

export const profileImportEnabled = PROXY !== "";

export interface ImportedHero {
  id: string;
  name: string;
  games: number;
  wins: number;
}

export interface ImportedProfile {
  uid: string;
  matches: number;
  heroes: ImportedHero[];
}

const PAGE_SIZE = 20;
const MAX_PAGES = 5; // most recent ~100 matches is plenty for a pool

/** Heroes with enough games to count as comfort picks. */
export function poolOf(profile: ImportedProfile, minGames = 3): string[] {
  return profile.heroes.filter((h) => h.games >= minGames).map((h) => h.id);
}

export async function importProfile(uid: string): Promise<ImportedProfile> {
  const snapshot = await loadSnapshot();
  const heroByApiId = new Map(snapshot.heroes.map((h) => [h.rivalsMetaId, h]));
  const season = snapshot.season.internalId;
  const base = PROXY.replace(/\/$/, "");

  const counts = new Map<string, ImportedHero>();
  let matches = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${base}/api/player-match-history/${encodeURIComponent(uid)}` +
        `?skip=${page * PAGE_SIZE}&game_mode_id=2&hero_id=0&season=${season}`,
    );
    if (!res.ok) {
      throw new Error(
        res.status === 500
          ? "Player not found — check the UID (visible on your in-game profile)."
          : `Profile fetch failed (${res.status}).`,
      );
    }
    const items = (await res.json()) as Array<{
      match_player?: { is_win?: number; player_hero?: { hero_id?: number } };
    }>;
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      const apiId = item.match_player?.player_hero?.hero_id;
      const hero = apiId != null ? heroByApiId.get(apiId) : undefined;
      if (hero == null) continue;
      matches++;
      const agg = counts.get(hero.id) ?? {
        id: hero.id,
        name: hero.name,
        games: 0,
        wins: 0,
      };
      agg.games++;
      if (item.match_player?.is_win === 1) agg.wins++;
      counts.set(hero.id, agg);
    }
    if (items.length < PAGE_SIZE) break;
  }
  return {
    uid,
    matches,
    heroes: [...counts.values()].sort((a, b) => b.games - a.games),
  };
}
