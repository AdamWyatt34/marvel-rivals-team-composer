import { z } from "zod";

/**
 * The snapshot contract shared by the ingest scripts (writer) and the web
 * app (reader). Raw counts only — win rates and shrinkage are computed in
 * the engine so scoring constants can change without re-ingesting.
 */

export const SCHEMA_VERSION = 1;

/**
 * RivalsMeta rank bucket codes, confirmed against the site's rank badge
 * icons (img_rank_dan_01 = Bronze … img_rank_dan_09 = One Above All).
 * Bucket "0" carries data but no badge; bans only exist for codes >= 3,
 * which matches the in-game Gold+ ban rule.
 */
export const TIER_LABELS: Record<string, string> = {
  "0": "Other",
  "1": "Bronze",
  "2": "Silver",
  "3": "Gold",
  "4": "Platinum",
  "5": "Diamond",
  "6": "Grandmaster",
  "7": "Celestial",
  "8": "Eternity",
  "9": "One Above All",
};

const countSchema = z.object({
  matches: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
});

const heroTierStatsSchema = z.object({
  /** All games (including mirrors) — use for pick volume. */
  matches: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  /** Mirror-excluded — use for win rates. */
  wrMatches: z.number().int().nonnegative(),
  wrWins: z.number().int().nonnegative(),
  /** Raw ban count; absent for tiers without bans (below Gold). */
  bans: z.number().int().nonnegative().optional(),
});

export const heroSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rivalsMetaId: z.number().int(),
  role: z.enum(["Vanguard", "Duelist", "Strategist"]),
});

export const mapSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  area: z.string(),
  mode: z.string(),
});

export const teamUpSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  anchor: z.string().nullable(),
  heroes: z.array(z.string()),
  currentlyActive: z.boolean(),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  season: z.object({
    internalId: z.number().int(),
    label: z.string().min(1),
  }),
  /** RivalsMeta's own data timestamp (unix seconds). */
  sourceTimestamp: z.number().int().positive(),
  heroes: z.array(heroSchema).min(35),
  maps: z.array(mapSchema).min(10),
  teamUps: z.array(teamUpSchema),
  /** Per rank-bucket per hero-slug raw counts. Keys are TIER_LABELS codes. */
  stats: z.record(z.string(), z.record(z.string(), heroTierStatsSchema)),
  /** Per hero-slug per map-id raw counts (all ranks; source is not bucketed). */
  heroMaps: z.record(z.string(), z.record(z.string(), countSchema)),
  /**
   * matchups[h][e] = h's games and wins in matches where e was on the enemy
   * team (Diamond+ aggregate; the source fixes this tier).
   */
  matchups: z.record(z.string(), z.record(z.string(), countSchema)),
  /**
   * teamUpStats[tierCode][teamUpId].variants is keyed by a sorted
   * "slug+slug" member combination.
   */
  teamUpStats: z.record(
    z.string(),
    z.record(
      z.string(),
      countSchema.extend({
        variants: z.record(z.string(), countSchema),
      }),
    ),
  ),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotHero = z.infer<typeof heroSchema>;
export type SnapshotMap = z.infer<typeof mapSchema>;
export type SnapshotTeamUp = z.infer<typeof teamUpSchema>;
export type HeroTierStats = z.infer<typeof heroTierStatsSchema>;
export type Count = z.infer<typeof countSchema>;
