import type { PairsTable } from "../../lib/data/pairs-schema";
import type { Snapshot } from "../../lib/data/schema";
import { scoreTeam } from "../../lib/engine/scorer";
import {
  buildScoringTables,
  SCORING_PARAMS,
  sigmoid,
  type TierBand,
} from "../../lib/engine/stats";
import { aggregatePairs, type CompRow } from "../pairs/aggregate";

/**
 * Backtest: score sampled real matches with the production engine and
 * measure how well the predicted win probabilities match outcomes. This is
 * the ground truth for every SCORING_PARAMS debate — a term earns its weight
 * by lowering log loss on held-out matches, not by sounding plausible.
 *
 * Honest evaluation is temporal: the newest quarter of matches is held out,
 * the pair/counter tables used for scoring are rebuilt from the older
 * three-quarters only, and every reported metric comes from the held-out
 * set. (The production pairs.json contains the evaluated matches, so scoring
 * with it would leak.) The temperature and multiplier fits happen on the
 * training portion.
 *
 * Each match is scored from BOTH orientations (a vs b and b vs a) because
 * the scorer has team-directional terms (shape, coverage). That yields a
 * prediction set with an exactly-0.5 base rate, so the coin-flip baselines
 * (ln 2 log loss, 0.25 Brier) are the honest reference.
 */

const P_CLAMP = 1e-6;
/** Below this many usable matches the holdout split is skipped (in-sample). */
const MIN_HOLDOUT_MATCHES = 400;
const HOLDOUT_FRACTION = 0.25;
const WINDOW_DAYS = 60;

export interface Prediction {
  p: number;
  /** Log-odds deviation from the band's base rate (z - zBar). */
  zRel: number;
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

export interface MultiplierSuggestion {
  param: string;
  /** Train-fitted best multiplier on the current value (1 = keep as is). */
  best: number;
  /** Train log loss at the best multiplier vs at 1. */
  delta: number;
}

export interface BacktestReport {
  generatedAt: string;
  band: TierBand;
  nMatches: number;
  nSkipped: number;
  nPredictions: number;
  /** Held-out metrics when holdout != null; in-sample otherwise. */
  logLoss: number;
  logLossBaseline: number;
  brier: number;
  brierBaseline: number;
  accuracy: number;
  calibration: CalibrationBin[];
  ablations: AblationResult[];
  holdout: {
    trainMatches: number;
    testMatches: number;
    cutoffEpoch: number;
  } | null;
  /** Train-fitted sigmoid temperature and the test log loss it achieves. */
  temperature: number;
  logLossCalibrated: number;
  multipliers: MultiplierSuggestion[];
  /** Temperature fitted on ALL rows with the production pair table — the
   * value the app should ship (1-param fit; in-sample is acceptable). */
  productionTemperature: number | null;
}

const ABLATION_PARAMS = [
  "K_HERO",
  "K_MATCHUP",
  "K_MAP",
  "K_TEAMUP",
  "K_SHAPE",
  "K_COVERAGE",
  "K_PAIR",
  "K_COUNTER",
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
    const ab = scoreTeam(tables, row.a, row.b, row.m);
    const ba = scoreTeam(tables, row.b, row.a, row.m);
    predictions.push(
      { p: ab.prob, zRel: ab.z - tables.zBar, won: row.w === "a" },
      { p: ba.prob, zRel: ba.z - tables.zBar, won: row.w === "b" },
    );
  }
  return { predictions, nMatches, nSkipped };
}

/** Log loss with the temperature applied around the base rate. Assumes the
 * symmetric two-orientation prediction set, where zBar contributes equally
 * to both sides — the base term is folded into zRel = 0. */
function logLossAtTemperature(
  predictions: readonly Prediction[],
  t: number,
): number {
  if (predictions.length === 0) return NaN;
  let sum = 0;
  for (const { zRel, won } of predictions) {
    const q = Math.min(1 - P_CLAMP, Math.max(P_CLAMP, sigmoid(t * zRel)));
    sum -= won ? Math.log(q) : Math.log(1 - q);
  }
  return sum / predictions.length;
}

/** Golden-section search for the log-loss-minimizing temperature. */
export function fitTemperature(predictions: readonly Prediction[]): number {
  let lo = 0.2;
  let hi = 10;
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = logLossAtTemperature(predictions, x1);
  let f2 = logLossAtTemperature(predictions, x2);
  for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
    if (f1 <= f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = logLossAtTemperature(predictions, x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = logLossAtTemperature(predictions, x2);
    }
  }
  return (lo + hi) / 2;
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

/** Run fn with one scoring param scaled; always restores the original. */
function withParamScaled<T>(param: string, mult: number, fn: () => T): T {
  const params = SCORING_PARAMS as unknown as Record<string, number>;
  const original = params[param];
  params[param] = original * mult;
  try {
    return fn();
  } finally {
    params[param] = original;
  }
}

const MULTIPLIER_GRID = [0, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function runBacktest(
  rows: readonly CompRow[],
  snapshot: Snapshot,
  pairs: PairsTable | null,
  band: TierBand,
  now: Date,
): BacktestReport {
  const sorted = [...rows].sort((x, y) => x.t - y.t);
  const useHoldout = sorted.length >= MIN_HOLDOUT_MATCHES;
  const cutoffIdx = useHoldout
    ? Math.floor(sorted.length * (1 - HOLDOUT_FRACTION))
    : 0;
  const train = useHoldout ? sorted.slice(0, cutoffIdx) : sorted;
  const test = useHoldout ? sorted.slice(cutoffIdx) : sorted;
  // Score with tables built from training matches only — the production
  // pairs table contains the evaluated matches and would leak.
  const evalPairs = useHoldout
    ? aggregatePairs(train, now, WINDOW_DAYS)
    : pairs;

  const trainPredictions = useHoldout
    ? predictRows(train, snapshot, evalPairs, band).predictions
    : predictRows(test, snapshot, evalPairs, band).predictions;
  const temperature = fitTemperature(trainPredictions);

  const { predictions, nMatches, nSkipped } = predictRows(
    test,
    snapshot,
    evalPairs,
    band,
  );
  const fullLogLoss = logLoss(predictions);
  const calibrated = predictions.map((p) => ({
    ...p,
    p: sigmoid(temperature * p.zRel),
  }));

  const ablations: AblationResult[] = [];
  const multipliers: MultiplierSuggestion[] = [];
  if (nMatches > 0) {
    const trainRows = useHoldout ? train : test;
    const atOne = logLoss(trainPredictions);
    for (const param of ABLATION_PARAMS) {
      // Rebuild tables inside the scaled scope: some params (K_DEMAND) are
      // baked in at table-build time, not read at scoring time.
      const ablatedLoss = withParamZeroed(param, () =>
        logLoss(predictRows(test, snapshot, evalPairs, band).predictions),
      );
      ablations.push({
        param,
        logLoss: ablatedLoss,
        delta: ablatedLoss - fullLogLoss,
      });

      let best = 1;
      let bestLoss = atOne;
      for (const mult of MULTIPLIER_GRID) {
        if (mult === 1) continue;
        const loss = withParamScaled(param, mult, () =>
          logLoss(
            predictRows(trainRows, snapshot, evalPairs, band).predictions,
          ),
        );
        if (loss < bestLoss) {
          best = mult;
          bestLoss = loss;
        }
      }
      multipliers.push({ param, best, delta: bestLoss - atOne });
    }
  }

  // The shipped temperature is fit on everything with the production table:
  // a 1-parameter fit doesn't overfit, and the app scores with that table.
  const allPredictions = predictRows(sorted, snapshot, pairs, band).predictions;
  const productionTemperature =
    allPredictions.length > 0 ? fitTemperature(allPredictions) : null;

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
    calibration: calibrationBins(calibrated),
    ablations,
    holdout: useHoldout
      ? {
          trainMatches: train.length,
          testMatches: test.length,
          cutoffEpoch: sorted[cutoffIdx].t,
        }
      : null,
    temperature,
    logLossCalibrated: logLoss(calibrated),
    multipliers,
    productionTemperature,
  };
}
