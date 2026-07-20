"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * Model report card: renders the daily backtest (public/data/backtest.json)
 * — how well the scorer's win probabilities match real held-out matches.
 */

interface Bin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  actualRate: number;
}
interface Ablation {
  param: string;
  delta: number;
}
interface Report {
  generatedAt: string;
  band: string;
  nMatches: number;
  logLoss: number;
  logLossBaseline: number;
  logLossCalibrated: number;
  accuracy: number;
  temperature: number;
  calibration: Bin[];
  ablations: Ablation[];
  holdout: { trainMatches: number; testMatches: number } | null;
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const TERM_LABELS: Record<string, string> = {
  K_HERO: "Hero strength",
  K_MATCHUP: "Matchups",
  K_MAP: "Maps",
  K_TEAMUP: "Team-ups",
  K_SHAPE: "Role shape",
  K_COVERAGE: "Threat coverage",
  K_PAIR: "Pair synergy",
  K_COUNTER: "Learned counters",
  K_DEMAND: "Demand tilt",
};

export default function ModelPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`${BASE_PATH}/data/backtest.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((r: Report) => setReport(r))
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <main style={page}>
        <h1 className="page-title">Model report card</h1>
        <p style={{ color: "var(--muted)" }}>
          No backtest report published yet — it appears once enough matches have
          been sampled.
        </p>
      </main>
    );
  }
  if (report == null) {
    return (
      <main style={page}>
        <h1 className="page-title">Model report card</h1>
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      </main>
    );
  }

  const edge = report.logLossBaseline - report.logLossCalibrated;
  const ablations = [...report.ablations].sort((a, b) => b.delta - a.delta);
  const maxAbs = Math.max(...ablations.map((a) => Math.abs(a.delta)), 1e-6);

  return (
    <main style={page}>
      <header style={{ marginBottom: 16 }}>
        <h1 className="page-title">Model report card</h1>
        <p style={subtitle}>
          Every day the scorer predicts{" "}
          {report.holdout
            ? `the newest ${report.holdout.testMatches} sampled matches it has
               never seen, using data from the older
               ${report.holdout.trainMatches}`
            : `${report.nMatches} sampled matches`}{" "}
          ({report.band}). These are the honest results, updated{" "}
          {new Date(report.generatedAt).toLocaleDateString()}.
        </p>
      </header>

      <div style={tileRow}>
        <StatTile
          label="Accuracy"
          value={`${(report.accuracy * 100).toFixed(1)}%`}
          note="coin flip = 50%"
        />
        <StatTile
          label="Log loss"
          value={report.logLossCalibrated.toFixed(4)}
          note={`coin flip = ${report.logLossBaseline.toFixed(4)}`}
          good={edge > 0}
        />
        <StatTile
          label="Matches evaluated"
          value={String(report.holdout?.testMatches ?? report.nMatches)}
          note="held out from training"
        />
        <StatTile
          label="Temperature"
          value={report.temperature.toFixed(2)}
          note="probability calibration"
        />
      </div>

      <section style={section}>
        <h2 style={h2}>Calibration — predicted vs actual</h2>
        <p style={caption}>
          Each dot is a bucket of predictions; on the dashed line, a “60%”
          prediction wins 60% of the time.
        </p>
        <CalibrationPlot bins={report.calibration} />
      </section>

      <section style={section}>
        <h2 style={h2}>
          Which terms earn their keep{" "}
          <span
            style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}
          >
            (Δ log loss when removed)
          </span>
        </h2>
        <div role="img" aria-label="Per-term ablation deltas">
          {ablations.map((a) => {
            const helps = a.delta >= 0;
            const width = (Math.abs(a.delta) / maxAbs) * 50;
            return (
              <div key={a.param} style={ablationRow}>
                <span style={ablationLabel}>
                  {TERM_LABELS[a.param] ?? a.param}
                </span>
                <div style={ablationTrack}>
                  <div
                    style={{
                      position: "absolute",
                      left: helps ? "50%" : `${50 - width}%`,
                      width: `${width}%`,
                      height: 12,
                      borderRadius: 4,
                      background: helps ? "var(--my)" : "var(--enemy)",
                    }}
                    title={`${TERM_LABELS[a.param] ?? a.param}: ${a.delta >= 0 ? "+" : ""}${a.delta.toFixed(5)}`}
                  />
                  <div style={zeroLine} />
                </div>
                <span
                  style={{
                    ...ablationValue,
                    color: helps ? "var(--text)" : "var(--enemy)",
                  }}
                >
                  {helps ? "helps" : "hurts"} {Math.abs(a.delta).toFixed(4)}
                </span>
              </div>
            );
          })}
        </div>
        <p style={caption}>
          Bars right of center improve prediction; left of center make it worse.
          Weights are retuned from this evidence, not intuition.
        </p>
      </section>

      <details style={{ marginTop: 20 }}>
        <summary style={{ color: "var(--muted)", cursor: "pointer" }}>
          Data table
        </summary>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Predicted bucket</th>
              <th style={th}>n</th>
              <th style={th}>Mean predicted</th>
              <th style={th}>Actual win rate</th>
            </tr>
          </thead>
          <tbody>
            {report.calibration.map((b) => (
              <tr key={b.lo}>
                <td style={td}>
                  {(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%
                </td>
                <td style={td}>{b.count}</td>
                <td style={td}>{(b.meanPredicted * 100).toFixed(1)}%</td>
                <td style={td}>{(b.actualRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </main>
  );
}

function StatTile({
  label,
  value,
  note,
  good,
}: {
  label: string;
  value: string;
  note: string;
  good?: boolean;
}) {
  return (
    <div style={tile}>
      <div style={tileLabel}>{label}</div>
      <div style={tileValue}>{value}</div>
      {good != null && (
        <div
          style={{
            fontSize: 12,
            whiteSpace: "nowrap",
            color: good ? "var(--my)" : "var(--enemy)",
          }}
        >
          {good ? "▲ beats baseline" : "▼ below baseline"}
        </div>
      )}
      <div style={tileNote}>{note}</div>
    </div>
  );
}

function CalibrationPlot({ bins }: { bins: Bin[] }) {
  const [hover, setHover] = useState<Bin | null>(null);
  const W = 340;
  const H = 300;
  const PAD = 36;
  const sx = (v: number) => PAD + v * (W - PAD - 10);
  const sy = (v: number) => H - PAD - v * (H - PAD - 10);
  const maxCount = Math.max(...bins.map((b) => b.count));

  return (
    <div style={{ position: "relative", maxWidth: W }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Calibration plot of predicted vs actual win rate"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line
              x1={sx(t)}
              y1={sy(0)}
              x2={sx(t)}
              y2={sy(1)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <line
              x1={sx(0)}
              y1={sy(t)}
              x2={sx(1)}
              y2={sy(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text x={sx(t)} y={H - PAD + 16} textAnchor="middle" style={tick}>
              {t * 100}%
            </text>
            <text x={PAD - 8} y={sy(t) + 4} textAnchor="end" style={tick}>
              {t * 100}%
            </text>
          </g>
        ))}
        <line
          x1={sx(0)}
          y1={sy(0)}
          x2={sx(1)}
          y2={sy(1)}
          stroke="var(--muted-border)"
          strokeWidth={1.5}
          strokeDasharray="5 4"
        />
        {bins.map((b) => (
          <circle
            key={b.lo}
            cx={sx(b.meanPredicted)}
            cy={sy(b.actualRate)}
            r={Math.max(5, 5 + 7 * Math.sqrt(b.count / maxCount))}
            fill="var(--accent)"
            fillOpacity={0.85}
            stroke="var(--card)"
            strokeWidth={2}
            onMouseEnter={() => setHover(b)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
        <text x={sx(0.5)} y={H - 4} textAnchor="middle" style={axisLabel}>
          predicted win rate
        </text>
        <text
          x={10}
          y={sy(0.5)}
          style={axisLabel}
          transform={`rotate(-90 10 ${sy(0.5)})`}
          textAnchor="middle"
        >
          actual win rate
        </text>
      </svg>
      {hover != null && (
        <div
          style={{
            ...tooltip,
            left: `${(sx(hover.meanPredicted) / W) * 100}%`,
            top: `${(sy(hover.actualRate) / H) * 100}%`,
          }}
        >
          predicted {(hover.meanPredicted * 100).toFixed(1)}% → won{" "}
          {(hover.actualRate * 100).toFixed(1)}% · n={hover.count}
        </div>
      )}
    </div>
  );
}

/* styles */

const page: CSSProperties = {
  padding: "20px 24px 40px",
  maxWidth: 760,
  margin: "0 auto",
  color: "var(--text)",
  minHeight: "100vh",
};
const subtitle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted)",
  fontSize: 13,
  maxWidth: 560,
};
const tileRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
  marginBottom: 20,
};
const tile: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "12px 14px",
};
const tileLabel: CSSProperties = { fontSize: 12, color: "var(--muted)" };
const tileValue: CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  margin: "2px 0",
};
const tileNote: CSSProperties = { fontSize: 12, color: "var(--muted)" };
const section: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 14,
};
const h2: CSSProperties = { fontSize: 16, margin: "0 0 4px" };
const caption: CSSProperties = {
  fontSize: 12,
  color: "var(--muted)",
  margin: "4px 0 10px",
};
const tick: CSSProperties = { fontSize: 10, fill: "var(--muted)" };
const axisLabel: CSSProperties = { fontSize: 11, fill: "var(--muted)" };
const tooltip: CSSProperties = {
  position: "absolute",
  transform: "translate(-50%, -130%)",
  background: "var(--chip)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "4px 8px",
  fontSize: 12,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};
const ablationRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 6,
};
const ablationLabel: CSSProperties = {
  width: 130,
  fontSize: 13,
  textAlign: "right",
  flexShrink: 0,
};
const ablationTrack: CSSProperties = {
  position: "relative",
  flex: 1,
  height: 12,
  minWidth: 120,
};
const zeroLine: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: -2,
  bottom: -2,
  width: 1,
  background: "var(--muted-border)",
};
const ablationValue: CSSProperties = {
  width: 110,
  fontSize: 12,
  flexShrink: 0,
};
const table: CSSProperties = {
  borderCollapse: "collapse",
  marginTop: 10,
  fontSize: 13,
};
const th: CSSProperties = {
  textAlign: "left",
  padding: "4px 12px 4px 0",
  color: "var(--muted)",
  fontWeight: 600,
};
const td: CSSProperties = {
  padding: "3px 12px 3px 0",
  borderTop: "1px solid var(--border)",
};
