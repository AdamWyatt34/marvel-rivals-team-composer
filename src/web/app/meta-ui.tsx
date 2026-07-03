"use client";

import { type CSSProperties, type ReactNode } from "react";
import { TIER_BANDS, type TierBand } from "../lib/engine";

/** Shared pieces for the meta explorer pages. */

export const BAND_LABELS: Record<TierBand, string> = {
  all: "All ranks",
  "gold+": "Gold+",
  "platinum+": "Platinum+",
  "diamond+": "Diamond+",
  "grandmaster+": "Grandmaster+",
};

export function BandSelect({
  band,
  onChange,
}: {
  band: TierBand;
  onChange: (b: TierBand) => void;
}) {
  return (
    <select
      value={band}
      onChange={(e) => onChange(e.target.value as TierBand)}
      aria-label="Select rank band"
      style={{
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--card)",
        color: "var(--text)",
        fontSize: 13,
      }}
    >
      {(Object.keys(TIER_BANDS) as TierBand[]).map((b) => (
        <option key={b} value={b}>
          {BAND_LABELS[b]}
        </option>
      ))}
    </select>
  );
}

/**
 * Single-hue magnitude meter (sequential): neutral track, one accent fill,
 * value always shown as text next to it — the meter is reinforcement, not
 * the only encoding.
 */
export function Meter({
  value,
  max,
  format,
}: {
  value: number;
  max: number;
  format: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minWidth: 130,
      }}
    >
      <span style={meterTrack} aria-hidden>
        <span style={{ ...meterFill, width: `${pct}%` }} />
      </span>
      <span style={meterText}>{format}</span>
    </span>
  );
}

/**
 * Diverging meter (polarity): favorable/unfavorable around a neutral gray
 * midpoint; two poles only, value as text.
 */
export function DivergingMeter({
  value,
  max,
  format,
}: {
  /** signed value; positive = favorable */
  value: number;
  max: number;
  format: string;
}) {
  const half = Math.min(1, Math.abs(value) / max) * 50;
  const positive = value >= 0;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        minWidth: 150,
      }}
    >
      <span style={{ ...meterTrack, position: "relative" }} aria-hidden>
        <span
          style={{
            position: "absolute",
            left: positive ? "50%" : `${50 - half}%`,
            width: `${half}%`,
            height: "100%",
            borderRadius: 999,
            background: positive ? "var(--tier-a)" : "var(--enemy)",
          }}
        />
        <span
          style={{
            position: "absolute",
            left: "50%",
            width: 1,
            height: "100%",
            background: "var(--muted-border)",
          }}
        />
      </span>
      <span style={meterText}>{format}</span>
    </span>
  );
}

export function MetaPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main style={pageStyle}>
      <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
      <p style={{ margin: "4px 0 16px", color: "var(--muted)", fontSize: 13 }}>
        {subtitle}
      </p>
      {children}
    </main>
  );
}

export const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

export const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--muted-strong)",
};

export const tdStyle: CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

export function roleBadge(role: string): CSSProperties {
  const bg =
    role === "Vanguard"
      ? "var(--role-vang)"
      : role === "Duelist"
        ? "var(--role-duel)"
        : "var(--role-strat)";
  return {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 700,
    padding: "1px 8px",
    borderRadius: 999,
    background: bg,
    color: "var(--text)",
  };
}

export function tierBadge(tier: string): CSSProperties {
  const bg =
    tier === "S"
      ? "var(--tier-s)"
      : tier === "A"
        ? "var(--tier-a)"
        : tier === "B"
          ? "var(--tier-b)"
          : tier === "C"
            ? "var(--tier-c)"
            : "var(--tier-d)";
  return {
    display: "inline-block",
    fontSize: 10,
    fontWeight: 700,
    padding: "1px 8px",
    borderRadius: 999,
    background: bg,
    color: "#fff",
  };
}

const pageStyle: CSSProperties = {
  padding: "20px 24px 40px",
  maxWidth: 980,
  margin: "0 auto",
  color: "var(--text)",
};

const meterTrack: CSSProperties = {
  display: "inline-block",
  width: 70,
  height: 6,
  borderRadius: 999,
  background: "var(--chip)",
  overflow: "hidden",
};

const meterFill: CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "var(--my)",
};

const meterText: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontSize: 12,
};
