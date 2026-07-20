import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pairsTableSchema, type PairsTable } from "../../lib/data/pairs-schema";
import { snapshotSchema } from "../../lib/data/schema";
import { TIER_BANDS, type TierBand } from "../../lib/engine/stats";
import type { CompRow } from "../pairs/aggregate";
import { runBacktest, type BacktestReport } from "./calibrate";

/**
 * CLI: backtest the scoring engine against sampled real matches.
 *
 *   npm run backtest             # grandmaster+ band (sampled players are top-ladder)
 *   npm run backtest -- --band=diamond+
 *
 * Prints the calibration report; once enough matches have accumulated it
 * also writes data/backtest/latest.json and appends a summary line to
 * data/backtest/history.jsonl so parameter changes can be compared over time.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const PAIRS_DIR = resolve(REPO_ROOT, "data/pairs");
const BACKTEST_DIR = resolve(REPO_ROOT, "data/backtest");
const SNAPSHOT_PATH = resolve(SCRIPT_DIR, "../../public/data/snapshot.json");
const PAIRS_TABLE_PATH = resolve(SCRIPT_DIR, "../../public/data/pairs.json");
const CALIBRATION_PATH = resolve(
  SCRIPT_DIR,
  "../../public/data/calibration.json",
);

const MIN_MATCHES = Number(process.env.BACKTEST_MIN_MATCHES ?? 200);

function bandFromArgs(): TierBand {
  const arg = process.argv.find((a) => a.startsWith("--band="));
  const band = (arg?.slice("--band=".length) ?? "grandmaster+") as TierBand;
  if (!(band in TIER_BANDS)) {
    console.error(
      `Unknown band "${band}" — expected one of: ${Object.keys(TIER_BANDS).join(", ")}`,
    );
    process.exit(1);
  }
  return band;
}

function loadCompRows(): CompRow[] {
  if (!existsSync(PAIRS_DIR)) return [];
  const rows: CompRow[] = [];
  for (const file of readdirSync(PAIRS_DIR)) {
    if (!/^comps-\d{4}-\d{2}\.jsonl$/.test(file)) continue;
    for (const line of readFileSync(resolve(PAIRS_DIR, file), "utf8").split(
      "\n",
    )) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line) as CompRow);
    }
  }
  return rows;
}

function loadPairsTable(): PairsTable | null {
  if (!existsSync(PAIRS_TABLE_PATH)) return null;
  const table = pairsTableSchema.parse(
    JSON.parse(readFileSync(PAIRS_TABLE_PATH, "utf8")),
  );
  return table.totalMatches > 0 ? table : null;
}

function printReport(report: BacktestReport) {
  const fmt = (x: number) => (Number.isNaN(x) ? "—" : x.toFixed(4));
  const scope = report.holdout
    ? `held-out ${report.holdout.testMatches} of ${report.nMatches + report.holdout.trainMatches}`
    : `in-sample ${report.nMatches} (too few for a holdout)`;
  console.log(
    `\nBacktest @ ${report.band} — ${scope} matches` +
      ` (${report.nPredictions} predictions, ${report.nSkipped} rows skipped)`,
  );
  console.log(
    `  log loss  ${fmt(report.logLoss)}  (coin flip ${fmt(report.logLossBaseline)})`,
  );
  console.log(
    `  with T    ${fmt(report.logLossCalibrated)}  (temperature ${report.temperature.toFixed(2)})`,
  );
  console.log(
    `  Brier     ${fmt(report.brier)}  (coin flip ${fmt(report.brierBaseline)})`,
  );
  console.log(`  accuracy  ${fmt(report.accuracy)}`);

  if (report.calibration.length > 0) {
    console.log("\n  calibration (predicted → actual):");
    for (const bin of report.calibration) {
      console.log(
        `    [${bin.lo.toFixed(1)}–${bin.hi.toFixed(1)})  n=${String(bin.count).padStart(5)}` +
          `  predicted ${bin.meanPredicted.toFixed(3)}  actual ${bin.actualRate.toFixed(3)}`,
      );
    }
  }

  if (report.ablations.length > 0) {
    console.log(
      "\n  ablations (Δ log loss when term removed; + = term helps):",
    );
    for (const a of report.ablations) {
      const sign = a.delta >= 0 ? "+" : "";
      console.log(`    ${a.param.padEnd(11)} ${sign}${a.delta.toFixed(5)}`);
    }
  }

  const moved = report.multipliers.filter((m) => m.best !== 1);
  if (moved.length > 0) {
    console.log(
      "\n  weight suggestions (train-fitted multiplier on current value):",
    );
    for (const m of moved) {
      console.log(
        `    ${m.param.padEnd(11)} ×${m.best}  (train Δ ${m.delta.toFixed(5)})`,
      );
    }
  }
}

function main() {
  const band = bandFromArgs();
  const rows = loadCompRows();
  if (rows.length === 0) {
    console.log(
      "No sampled matches yet (data/pairs/comps-*.jsonl) — nothing to backtest.",
    );
    return;
  }

  const snapshot = snapshotSchema.parse(
    JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")),
  );
  const report = runBacktest(
    rows,
    snapshot,
    loadPairsTable(),
    band,
    new Date(),
  );
  printReport(report);

  if (report.nMatches < MIN_MATCHES) {
    console.log(
      `\nOnly ${report.nMatches} usable matches (< ${MIN_MATCHES}) — metrics are noise; not writing a report yet.`,
    );
    return;
  }

  mkdirSync(BACKTEST_DIR, { recursive: true });
  writeFileSync(
    resolve(BACKTEST_DIR, "latest.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  // Also published for the site's model report-card page.
  writeFileSync(
    resolve(SCRIPT_DIR, "../../public/data/backtest.json"),
    JSON.stringify(report) + "\n",
  );
  appendFileSync(
    resolve(BACKTEST_DIR, "history.jsonl"),
    JSON.stringify({
      generatedAt: report.generatedAt,
      band: report.band,
      nMatches: report.nMatches,
      logLoss: report.logLoss,
      logLossCalibrated: report.logLossCalibrated,
      brier: report.brier,
      accuracy: report.accuracy,
      temperature: report.temperature,
      heldOut: report.holdout != null,
    }) + "\n",
  );
  console.log(`\nWrote data/backtest/latest.json (+ history.jsonl).`);

  if (report.productionTemperature != null) {
    writeFileSync(
      CALIBRATION_PATH,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: report.generatedAt,
        band: report.band,
        temperature: Number(report.productionTemperature.toFixed(4)),
        nPredictions: report.nPredictions,
      }) + "\n",
    );
    console.log(
      `Wrote public/data/calibration.json (temperature ${report.productionTemperature.toFixed(2)}).`,
    );
  }
}

main();
