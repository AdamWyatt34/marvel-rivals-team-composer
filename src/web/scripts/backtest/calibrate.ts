import type { PairsTable } from "../../lib/data/pairs-schema";
import type { Snapshot } from "../../lib/data/schema";
import { scoreTeam } from "../../lib/engine/scorer";
import {
  buildScoringTables,
  SCORING_PARAMS,
  type TierBand,
} from "../../lib/engine/stats";
import type { CompRow } from "../pairs/aggregate";

/**
 * Backtest: score sampled real matches with the production engine and
 * measure how well the predicted win probabilities match outcomes. This is
 * the ground truth for every SCORING_PARAMS debate — a term earns its weight
 * by lowering log loss on held-out matches, not by sounding plausible.
 *
 * Each match is scored from BOTH orientations (a vs b and b vs a) because
 * the scorer has team-directional terms (shape, coverage). That yields a
 * prediction set with an exactly-0.5 base rate, so the coin-flip baselines
 * (ln 2 log loss, 0.25 Brier) are the honest reference.
 */

const P_CLAMP = 1e-6;

export interface Prediction {
  p: number;
  won: boolean;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  actualRate: number;
}

export interface AblationResult {
  param: string;
  logLoss: number;
  /** ablated − full; positive means the term improves prediction. */
  delta: number;
}

export interface BacktestReport {
  generatedAt: string;
  band: TierBand;
  nMatches: number;
  nSkipped: number;
  nPredictions: number;
  logLoss: number;
  logLossBaseline: number;
  brier: number;
  brierBaseline: number;
  accuracy: number;
  calibration: CalibrationBin[];
  ablations: AblationResult[];
}

/** Params whose contribution the ablation pass measures. K_MAP is omitted:
 * sampled comp rows carry no map id, so the map term is inert here. */
const ABLATION_PARAMS = [
  "K_HERO",
  "K_MATCHUP",
  "K_TEAMUP",
  "K_SHAPE",
  "K_COVERAGE",
  "K_PAIR",
  "K_DEMAND",
] as const;

export function predictRows(
  rows: readonly CompRow[],
  snapshot: Snapshot,
  pairs: PairsTable | null,
  band: TierBand,
): { predictions: Prediction[]; nMatches: number; nSkipped: number } {
  const tables = buildScoringTables(snapshot, band, pairs);
  const predictions: Prediction[] = [];
  let nMatches = 0;
  let nSkipped = 0;
  for (const row of rows) {
    const known = [...row.a, ...row.b].every((id) => tables.heroes.has(id));
    if (!known || row.a.length !== 6 || row.b.length !== 6) {
      nSkipped++;
      continue;
    }
    nMatches++;
    predictions.push(
      { p: scoreTeam(tables, row.a, row.b).prob, won: row.w === "a" },
      { p: scoreTeam(tables, row.b, row.a).prob, won: row.w === "b" },
    );
  }
  return { predictions, nMatches, nSkipped };
}

export function logLoss(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const { p, won } of predictions) {
    const q = Math.min(1 - P_CLAMP, Math.max(P_CLAMP, p));
    sum -= won ? Math.log(q) : Math.log(1 - q);
  }
  return sum / predictions.length;
}

export function brier(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const { p, won } of predictions) sum += (p - (won ? 1 : 0)) ** 2;
  return sum / predictions.length;
}

/** Fraction of predictions on the right side of 0.5; exact ties count half. */
export function accuracy(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return NaN;
  let correct = 0;
  for (const { p, won } of predictions) {
    if (p === 0.5) correct += 0.5;
    else if (p > 0.5 === won) correct += 1;
  }
  return correct / predictions.length;
}

export function calibrationBins(
  predictions: readonly Prediction[],
  binCount = 10,
): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lo = i / binCount;
    const hi = (i + 1) / binCount;
    const members = predictions.filter(
      ({ p }) => p >= lo && (p < hi || (i === binCount - 1 && p <= hi)),
    );
    if (members.length === 0) continue;
    bins.push({
      lo,
      hi,
      count: members.length,
      meanPredicted: members.reduce((sum, m) => sum + m.p, 0) / members.length,
      actualRate: members.filter((m) => m.won).length / members.length,
    });
  }
  return bins;
}

/** Run fn with one scoring param zeroed; always restores the original. */
function withParamZeroed<T>(param: string, fn: () => T): T {
  const params = SCORING_PARAMS as unknown as Record<string, number>;
  const original = params[param];
  params[param] = 0;
  try {
    return fn();
  } finally {
    params[param] = original;
  }
}

export function runBacktest(
  rows: readonly CompRow[],
  snapshot: Snapshot,
  pairs: PairsTable | null,
  band: TierBand,
  now: Date,
): BacktestReport {
  const { predictions, nMatches, nSkipped } = predictRows(
    rows,
    snapshot,
    pairs,
    band,
  );
  const fullLogLoss = logLoss(predictions);

  const ablations: AblationResult[] = [];
  if (nMatches > 0) {
    for (const param of ABLATION_PARAMS) {
      // Rebuild tables inside the zeroed scope: some params (K_DEMAND) are
      // baked in at table-build time, not read at scoring time.
      const ablatedLoss = withParamZeroed(param, () =>
        logLoss(predictRows(rows, snapshot, pairs, band).predictions),
      );
      ablations.push({
        param,
        logLoss: ablatedLoss,
        delta: ablatedLoss - fullLogLoss,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    band,
    nMatches,
    nSkipped,
    nPredictions: predictions.length,
    logLoss: fullLogLoss,
    logLossBaseline: Math.LN2,
    brier: brier(predictions),
    brierBaseline: 0.25,
    accuracy: accuracy(predictions),
    calibration: calibrationBins(predictions),
    ablations,
  };
}
