import { describe, expect, it } from "vitest";
import { FIXTURE } from "../../../lib/engine/__tests__/fixture";
import { SCORING_PARAMS } from "../../../lib/engine/stats";
import type { CompRow } from "../../pairs/aggregate";
import {
  accuracy,
  brier,
  calibrationBins,
  fitTemperature,
  logLoss,
  predictRows,
  runBacktest,
} from "../calibrate";

const pred = (p: number, won: boolean) => ({
  p,
  zRel: Math.log(p / (1 - p)),
  won,
});

const NOW = new Date("2026-07-03T00:00:00Z");

const STRONG = ["hela", "thor", "hulk", "loki", "mantis", "luna-snow"];
const WEAK = [
  "the-punisher",
  "magneto",
  "iron-man",
  "adam-warlock",
  "loki",
  "mantis",
];

const row = (w: "a" | "b", a = STRONG, b = WEAK): CompRow => ({
  t: 1_782_000_000,
  w,
  a,
  b,
});

describe("predictRows", () => {
  it("scores each match from both orientations", () => {
    const { predictions, nMatches, nSkipped } = predictRows(
      [row("a")],
      FIXTURE,
      null,
      "diamond+",
    );
    expect(nMatches).toBe(1);
    expect(nSkipped).toBe(0);
    expect(predictions).toHaveLength(2);
    // the stronger side is favored, and its orientation won
    const [pa, pb] = predictions;
    expect(pa.p).toBeGreaterThan(0.5);
    expect(pa.won).toBe(true);
    expect(pb.won).toBe(false);
  });

  it("skips rows with heroes missing from the snapshot", () => {
    const bad = row("a", ["unknown-hero", ...STRONG.slice(1)]);
    const { nMatches, nSkipped } = predictRows(
      [bad, row("b")],
      FIXTURE,
      null,
      "diamond+",
    );
    expect(nMatches).toBe(1);
    expect(nSkipped).toBe(1);
  });
});

describe("metrics", () => {
  it("log loss and Brier beat the coin flip when predictions are right", () => {
    const good = [pred(0.7, true), pred(0.3, false)];
    expect(logLoss(good)).toBeLessThan(Math.LN2);
    expect(brier(good)).toBeLessThan(0.25);
    expect(accuracy(good)).toBe(1);
  });

  it("log loss is worse than the coin flip when predictions are inverted", () => {
    const bad = [pred(0.7, false), pred(0.3, true)];
    expect(logLoss(bad)).toBeGreaterThan(Math.LN2);
    expect(accuracy(bad)).toBe(0);
  });

  it("exact 0.5 predictions count half toward accuracy", () => {
    expect(accuracy([pred(0.5, true)])).toBe(0.5);
  });

  it("calibration bins report mean predicted vs actual rate", () => {
    const bins = calibrationBins(
      [pred(0.62, true), pred(0.64, false), pred(0.05, false)],
      10,
    );
    const mid = bins.find((b) => b.lo === 0.6);
    expect(mid).toBeDefined();
    expect(mid!.count).toBe(2);
    expect(mid!.meanPredicted).toBeCloseTo(0.63, 10);
    expect(mid!.actualRate).toBe(0.5);
    // empty bins are omitted
    expect(bins.every((b) => b.count > 0)).toBe(true);
  });
});

describe("runBacktest", () => {
  it("produces a full report with ablations and restores params", () => {
    const before = { ...SCORING_PARAMS };
    const rows = [row("a"), row("a"), row("b", WEAK, STRONG)];
    const report = runBacktest(rows, FIXTURE, null, "diamond+", NOW);

    expect(report.nMatches).toBe(3);
    expect(report.nPredictions).toBe(6);
    expect(report.logLoss).toBeGreaterThan(0);
    expect(report.calibration.length).toBeGreaterThan(0);
    expect(report.ablations.map((a) => a.param)).toContain("K_HERO");
    // ablation must not leave params mutated
    expect(SCORING_PARAMS).toEqual(before);
  });

  it("removing the hero term hurts prediction when strength decides matches", () => {
    // strong side always wins in this synthetic set
    const rows = [row("a"), row("a"), row("b", WEAK, STRONG)];
    const report = runBacktest(rows, FIXTURE, null, "diamond+", NOW);
    const heroAblation = report.ablations.find((a) => a.param === "K_HERO");
    expect(heroAblation).toBeDefined();
    expect(heroAblation!.delta).toBeGreaterThan(0);
  });

  it("handles an empty row set without throwing", () => {
    const report = runBacktest([], FIXTURE, null, "diamond+", NOW);
    expect(report.nMatches).toBe(0);
    expect(report.ablations).toHaveLength(0);
    expect(Number.isNaN(report.logLoss)).toBe(true);
    expect(report.holdout).toBeNull();
    expect(report.productionTemperature).toBeNull();
  });

  it("splits a large sample temporally and reports held-out metrics", () => {
    // 500 matches over increasing timestamps: strong side always wins
    const rows: CompRow[] = [];
    for (let i = 0; i < 500; i++) {
      rows.push({ ...row(i % 2 === 0 ? "a" : "b"), t: 1_782_000_000 + i * 60 });
      if (i % 2 === 1) [rows[i].a, rows[i].b] = [rows[i].b, rows[i].a];
    }
    const report = runBacktest(rows, FIXTURE, null, "diamond+", NOW);
    expect(report.holdout).not.toBeNull();
    expect(report.holdout!.trainMatches).toBe(375);
    expect(report.holdout!.testMatches).toBe(125);
    expect(report.nMatches).toBe(125);
    // the split boundary is temporal, not positional shuffle
    expect(report.holdout!.cutoffEpoch).toBe(1_782_000_000 + 375 * 60);
  });
});

describe("fitTemperature", () => {
  it("fits T>1 for underconfident predictions and T<1 for overconfident", () => {
    // outcomes deterministic at z=±0.2 -> optimum pushes T up
    const under = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0
        ? { p: 0.55, zRel: 0.2, won: true }
        : { p: 0.45, zRel: -0.2, won: false },
    );
    expect(fitTemperature(under)).toBeGreaterThan(2);

    // strong claims that are right only 60% of the time -> optimum shrinks T
    const over: { p: number; zRel: number; won: boolean }[] = [];
    for (let i = 0; i < 100; i++) {
      over.push({ p: 0.88, zRel: 2, won: i % 10 < 6 });
      over.push({ p: 0.12, zRel: -2, won: i % 10 >= 6 });
    }
    expect(fitTemperature(over)).toBeLessThan(0.5);
  });
});
