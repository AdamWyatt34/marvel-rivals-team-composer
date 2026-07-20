"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

/**
 * Meta trends: per-hero win/pick/ban trajectories across daily snapshots
 * (public/data/trends.json, built from git history by scripts/trends).
 */

interface HeroSeries {
  name: string;
  role: string;
  wr: (number | null)[];
  pick: (number | null)[];
  ban: (number | null)[];
}
interface Trends {
  dates: string[];
  bands: Record<string, Record<string, HeroSeries>>;
}

type Metric = "wr" | "pick" | "ban";
const METRIC_LABELS: Record<Metric, string> = {
  wr: "Win rate",
  pick: "Pick share",
  ban: "Ban rate",
};

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const DELTA_LOOKBACK = 7;

function lastValue(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) return series[i];
  }
  return null;
}

/** Change vs ~a week of snapshots ago (earliest available if younger). */
function delta(series: (number | null)[]): number | null {
  let lastIdx = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] != null) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return null;
  for (let i = Math.max(0, lastIdx - DELTA_LOOKBACK); i < lastIdx; i++) {
    if (series[i] != null) return series[lastIdx]! - series[i]!;
  }
  return null;
}

export default function TrendsPage() {
  const [trends, setTrends] = useState<Trends | null>(null);
  const [failed, setFailed] = useState(false);
  const [band, setBand] = useState<"all" | "diamond+">("diamond+");
  const [metric, setMetric] = useState<Metric>("wr");

  useEffect(() => {
    fetch(`${BASE_PATH}/data/trends.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((t: Trends) => setTrends(t))
      .catch(() => setFailed(true));
  }, []);

  const rows = useMemo(() => {
    const heroes = trends?.bands[band];
    if (heroes == null) return [];
    return Object.entries(heroes)
      .map(([slug, h]) => {
        const series = h[metric];
        return {
          slug,
          name: h.name,
          role: h.role,
          series,
          current: lastValue(series),
          change: delta(series),
        };
      })
      .filter((r) => r.current != null)
      .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
  }, [trends, band, metric]);

  if (failed) {
    return (
      <main style={page}>
        <h1 className="page-title">Meta trends</h1>
        <p style={{ color: "var(--muted)" }}>
          No trend data published yet — it builds up from daily snapshots.
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <header style={{ marginBottom: 12 }}>
        <h1 className="page-title">Meta trends</h1>
        <p style={subtitle}>
          How each hero&apos;s numbers move across daily snapshots
          {trends
            ? ` (${trends.dates[0]} → ${trends.dates[trends.dates.length - 1]})`
            : ""}
          . Sorted by biggest recent move;{" "}
          <span style={{ color: "var(--my)" }}>▲ rising</span> /{" "}
          <span style={{ color: "var(--enemy)" }}>▼ falling</span> vs ~a week
          ago.
        </p>
      </header>

      <div style={controls}>
        {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            aria-pressed={metric === m}
            style={{
              ...toggleBtn,
              background: metric === m ? "var(--accent)" : "var(--chip)",
              color: metric === m ? "#fff" : "var(--text)",
            }}
          >
            {METRIC_LABELS[m]}
          </button>
        ))}
        <select
          value={band}
          onChange={(e) => setBand(e.target.value as "all" | "diamond+")}
          aria-label="Rank band"
          style={select}
        >
          <option value="diamond+">Diamond+</option>
          <option value="all">All ranks</option>
        </select>
      </div>

      {trends == null ? (
        <p style={{ color: "var(--muted)" }}>Loading…</p>
      ) : (
        <div style={list}>
          {rows.map((r) => (
            <div key={r.slug} className="trend-row">
              <span className="trend-name">{r.name}</span>
              <span className="trend-role">{r.role}</span>
              <span className="trend-spark">
                <Sparkline series={r.series} dates={trends.dates} />
              </span>
              <span className="trend-current">
                {metric === "ban"
                  ? `${((r.current ?? 0) * 100).toFixed(0)}%`
                  : `${((r.current ?? 0) * 100).toFixed(1)}%`}
              </span>
              <span
                className="trend-delta"
                style={{
                  color:
                    r.change == null || Math.abs(r.change) < 0.0005
                      ? "var(--muted)"
                      : r.change > 0
                        ? "var(--my)"
                        : "var(--enemy)",
                }}
              >
                {r.change == null
                  ? "—"
                  : `${r.change > 0 ? "▲" : r.change < 0 ? "▼" : "•"} ${(Math.abs(r.change) * 100).toFixed(1)}pp`}
              </span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function Sparkline({
  series,
  dates,
}: {
  series: (number | null)[];
  dates: string[];
}) {
  const W = 140;
  const H = 28;
  const points = series
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (points.length === 0) return <span style={{ width: W }} />;
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const span = Math.max(max - min, 0.001);
  const sx = (i: number) =>
    series.length > 1 ? (i / (series.length - 1)) * (W - 8) + 4 : W / 2;
  const sy = (v: number) => H - 5 - ((v - min) / span) * (H - 10);
  const path = points
    .map(
      (p, idx) =>
        `${idx === 0 ? "M" : "L"}${sx(p.i).toFixed(1)},${sy(p.v).toFixed(1)}`,
    )
    .join(" ");
  const last = points[points.length - 1];
  return (
    <svg
      width={W}
      height={H}
      style={{ flexShrink: 0 }}
      role="img"
      aria-label={`trend from ${(min * 100).toFixed(1)}% to ${(max * 100).toFixed(1)}%`}
    >
      <title>
        {`${dates[points[0].i]}: ${(points[0].v * 100).toFixed(1)}% → ${dates[last.i]}: ${(last.v * 100).toFixed(1)}%`}
      </title>
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} />
      <circle cx={sx(last.i)} cy={sy(last.v)} r={3} fill="var(--accent)" />
    </svg>
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
  maxWidth: 600,
};
const controls: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
  marginBottom: 14,
};
const toggleBtn: CSSProperties = {
  padding: "7px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  fontSize: 13,
};
const select: CSSProperties = {
  padding: "7px 10px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  fontSize: 13,
};
const list: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "6px 14px",
};
