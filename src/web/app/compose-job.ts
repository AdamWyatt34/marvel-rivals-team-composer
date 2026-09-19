import type { SnapshotMap } from "../lib/data/schema";
import {
  buildBackups, calibratedProb, compose, DEFAULT_RULES, explainTeam,
  SCORING_PARAMS, suggestBans, type ScoringTables, type TierBand,
} from "../lib/engine";

export type ComposePayload = {
  myLocked: string[];
  enemyLocked: string[];
  bans?: string[];
  map?: string;
  band?: TierBand;
  /** Restrict non-locked recommendations to these heroes ("my pool only"). */
  poolIds?: string[];
  /** Imported per-hero record; overlays the strength term for our side. */
  personal?: { id: string; games: number; wins: number }[];
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

/** Runs on every selection change, so it must stay cheap: no adversarial search. */
export function runComposeJob(
  tables: ScoringTables,
  maps: SnapshotMap[],
  payload: ComposePayload,
): ComposeResponse {
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
    { maps },
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
  return {
    low: calibratedProb(tables, z - sigma),
    high: calibratedProb(tables, z + sigma),
  };
}

/** Adversarial ban search; only worth its cost behind an explicit user action. */
export function runBansJob(
  tables: ScoringTables,
  payload: ComposePayload,
): { id: string; name: string }[] {
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

