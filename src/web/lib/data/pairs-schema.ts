import { z } from "zod";

/**
 * Same-team hero-pair counts, accumulated by the match-sampling workflow
 * (scripts/pairs). Optional input: the engine's pair-synergy term is zero
 * when this file is absent or empty, so the site works before any data
 * accumulates.
 */

export const PAIRS_SCHEMA_VERSION = 1;

const countSchema = z.object({
  matches: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
});

export const pairsTableSchema = z.object({
  schemaVersion: z.literal(PAIRS_SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  windowDays: z.number().int().positive(),
  totalMatches: z.number().int().nonnegative(),
  /** "a+b" (sorted slugs) -> counts. wins = times the pair's team won. */
  pairs: z.record(z.string(), countSchema),
  /**
   * "x|y" (x facing enemy y) -> counts. wins = times x's team won. Optional:
   * absent in tables written before the counter term existed.
   */
  counters: z.record(z.string(), countSchema).optional(),
});

export type PairsTable = z.infer<typeof pairsTableSchema>;
