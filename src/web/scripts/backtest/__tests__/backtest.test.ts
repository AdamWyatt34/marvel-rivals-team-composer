import { describe, expect, it } from "vitest";
import { FIXTURE } from "../../../lib/engine/__tests__/fixture";
import { SCORING_PARAMS } from "../../../lib/engine/stats";
import type { CompRow } from "../../pairs/aggregate";
import {
  accuracy,
  brier,
  calibrationBins,
  logLoss,
  predictRows,
  runBacktest,
} from "../calibrate";

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
    const good = [
      { p: 0.7, won: true },
      { p: 0.3, won: false },
    ];
    expect(logLoss(good)).toBeLessThan(Math.LN2);
    expect(brier(good)).toBeLessThan(0.25);
    expect(accuracy(good)).toBe(1);
  });

  it("log loss is worse than the coin flip when predictions are inverted", () => {
    const bad = [
      { p: 0.7, won: false },
      { p: 0.3, won: true },
    ];
    expect(logLoss(bad)).toBeGreaterThan(Math.LN2);
    expect(accuracy(bad)).toBe(0);
  });

  it("exact 0.5 predictions count half toward accuracy", () => {
    expect(accuracy([{ p: 0.5, won: true }])).toBe(0.5);
  });

  it("calibration bins report mean predicted vs actual rate", () => {
    const bins = calibrationBins(
      [
        { p: 0.62, won: true },
        { p: 0.64, won: false },
        { p: 0.05, won: false },
      ],
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
  });
});
