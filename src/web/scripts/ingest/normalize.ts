import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  type Snapshot,
  type SnapshotHero,
  type SnapshotMap,
  type SnapshotTeamUp,
} from "../../lib/data/schema";
import { seasonLabel, type RawMatchups, type RawStats } from "./rivalsmeta";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REFERENCE_DIR = resolve(SCRIPT_DIR, "../../../../data/reference");

function loadReference<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(REFERENCE_DIR, file), "utf8")) as T;
}

/** Deterministic key order so snapshot diffs stay readable. */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function normalize(
  stats: RawStats,
  matchups: RawMatchups,
  generatedAt: Date,
): Snapshot {
  const heroes = loadReference<SnapshotHero[]>("heroes.json");
  const maps = loadReference<SnapshotMap[]>("maps.json");
  const teamUps = loadReference<SnapshotTeamUp[]>("teamups.json");

  const slugById = new Map(heroes.map((h) => [h.rivalsMetaId, h.id]));
  const unmapped = new Set<number>();
  const slugOf = (rivalsMetaId: number): string | null => {
    const slug = slugById.get(rivalsMetaId);
    if (slug == null) unmapped.add(rivalsMetaId);
    return slug ?? null;
  };

  // stats[tier][heroSlug]
  const tierStats: Snapshot["stats"] = {};
  for (const bucket of stats.heroes) {
    const perHero: Record<string, Snapshot["stats"][string][string]> = {};
    for (const h of bucket.heroes) {
      if (h.hero_id == null) continue; // bucket aggregate row
      const slug = slugOf(h.hero_id);
      if (slug == null) continue;
      perHero[slug] = {
        matches: h.matches,
        wins: h.wins,
        wrMatches: h.wr_matches,
        wrWins: h.wr_wins,
      };
    }
    tierStats[bucket.rank] = sortKeys(perHero);
  }
  for (const bucket of stats.bans) {
    const perHero = tierStats[bucket.rank];
    if (perHero == null) continue;
    for (const b of bucket.bans) {
      if (b.hero_id === 0) continue; // "no ban" votes
      const slug = slugOf(b.hero_id);
      if (slug != null && perHero[slug] != null) perHero[slug].bans = b.bans;
    }
  }

  // heroMaps[heroSlug][mapId]
  const heroMaps: Snapshot["heroMaps"] = {};
  for (const entry of stats.maps) {
    if (entry.hero_id == null) continue; // global aggregate row
    const slug = slugOf(entry.hero_id);
    if (slug == null) continue;
    heroMaps[slug] = sortKeys(
      Object.fromEntries(
        entry.maps.map((m) => [
          String(m.map_id),
          { matches: m.matches, wins: m.wins },
        ]),
      ),
    );
  }

  // matchups[heroSlug][enemySlug], mirror pairs dropped
  const matchupTable: Snapshot["matchups"] = {};
  for (const [heroId, row] of Object.entries(matchups)) {
    const heroSlug = slugOf(Number(heroId));
    if (heroSlug == null) continue;
    const outRow: Record<string, { matches: number; wins: number }> = {};
    for (const [enemyId, count] of Object.entries(row)) {
      if (enemyId === heroId) continue;
      const enemySlug = slugOf(Number(enemyId));
      if (enemySlug == null) continue;
      outRow[enemySlug] = { matches: count.matches, wins: count.wins };
    }
    matchupTable[heroSlug] = sortKeys(outRow);
  }

  // teamUpStats[tier][teamUpId] with variants keyed by sorted slug combo
  const teamUpStats: Snapshot["teamUpStats"] = {};
  for (const bucket of stats.teamups) {
    const perTeamUp: Snapshot["teamUpStats"][string] = {};
    for (const [teamUpId, t] of Object.entries(bucket.teamups)) {
      // the bucket also carries a scalar total_matches entry — not a team-up
      if (typeof t !== "object" || t == null || typeof t.matches !== "number")
        continue;
      const variants: Record<string, { matches: number; wins: number }> = {};
      for (const [combo, count] of Object.entries(t.variants ?? {})) {
        const slugs = combo.split(",").map((id) => slugOf(Number(id)));
        if (slugs.some((s) => s == null)) continue;
        variants[(slugs as string[]).sort().join("+")] = count;
      }
      perTeamUp[teamUpId] = {
        matches: t.matches,
        wins: t.wins,
        variants: sortKeys(variants),
      };
    }
    teamUpStats[bucket.rank] = sortKeys(perTeamUp);
  }

  if (unmapped.size > 0) {
    throw new Error(
      `Unmapped RivalsMeta hero ids: ${[...unmapped].sort().join(", ")}. ` +
        `A new hero probably shipped — run "npm run build-reference -- --live", review the diff, and re-ingest.`,
    );
  }

  const knownMapIds = new Set(maps.map((m) => m.id));
  const unknownMapIds = new Set<string>();
  for (const perMap of Object.values(heroMaps)) {
    for (const mapId of Object.keys(perMap)) {
      if (!knownMapIds.has(mapId)) unknownMapIds.add(mapId);
    }
  }
  const mapsOut = [...maps];
  for (const mapId of [...unknownMapIds].sort()) {
    // Maps are display-only metadata; don't fail the whole ingest over a name.
    console.warn(
      `Unknown map_id ${mapId} — using placeholder name; update data/reference/maps.json`,
    );
    mapsOut.push({
      id: mapId,
      name: `Unknown Map (${mapId})`,
      area: "Unknown",
      mode: "Unknown",
    });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    season: { internalId: stats.season, label: seasonLabel(stats.season) },
    sourceTimestamp: stats.timestamp,
    heroes: [...heroes].sort((a, b) => a.id.localeCompare(b.id)),
    maps: mapsOut.sort((a, b) => a.id.localeCompare(b.id)),
    teamUps: [...teamUps].sort((a, b) => a.id - b.id),
    stats: sortKeys(tierStats),
    heroMaps: sortKeys(heroMaps),
    matchups: sortKeys(matchupTable),
    teamUpStats: sortKeys(teamUpStats),
  };
}
