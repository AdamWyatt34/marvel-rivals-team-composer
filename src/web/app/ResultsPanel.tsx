"use client";

import type { CSSProperties } from "react";
import type { ComposeResponse } from "./local-api";

type Props = {
  resp: ComposeResponse | null;
  pending: boolean;
  error: string | null;
  lockedIds: string[];
  suggestedBans: { id: string; name: string }[] | null;
  suggesting: boolean;
  onSuggestBans: () => void;
  canSuggestBans: boolean;
};

const ROLE_ORDER = ["Vanguard", "Duelist", "Strategist"];

export default function ResultsPanel({
  resp,
  pending,
  error,
  lockedIds,
  suggestedBans,
  suggesting,
  onSuggestBans,
  canSuggestBans,
}: Props) {
  return (
    <aside
      style={{ ...panel, opacity: pending ? 0.7 : 1 }}
      id="results"
      aria-live="polite"
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Recommended team</h2>
        {pending && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>updating…</span>
        )}
      </div>

      {error && (
        <p
          style={{
            color: "var(--enemy)",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </p>
      )}

      {resp && !error && (
        <>
          <WinBar p={resp.winProbability} />

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: 12,
            }}
          >
            {[...resp.primary]
              .sort(
                (a, b) =>
                  ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
              )
              .map((slot) => (
                <div key={slot.id} style={slotRow}>
                  <span
                    style={{ ...rolePill, background: roleColor(slot.role) }}
                  >
                    {slot.role[0]}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {slot.name}
                  </span>
                  {lockedIds.includes(slot.id) && (
                    <span style={lockTag}>locked</span>
                  )}
                </div>
              ))}
          </div>

          {Object.keys(resp.backups).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={sectionHeading}>Backups</h3>
              {ROLE_ORDER.filter((r) => resp.backups[r]?.length).map((role) => (
                <div key={role} style={{ fontSize: 13, marginTop: 2 }}>
                  <span style={{ color: "var(--muted)" }}>{role}:</span>{" "}
                  {resp.backups[role].join(", ")}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <h3 style={sectionHeading}>Bans</h3>
            {suggestedBans == null ? (
              <button
                onClick={onSuggestBans}
                disabled={suggesting || !canSuggestBans}
                style={banButton}
                title={
                  canSuggestBans
                    ? undefined
                    : "Ban suggestions use the heroes you've marked as banned"
                }
              >
                {suggesting ? "Searching…" : "Suggest bans"}
              </button>
            ) : suggestedBans.length > 0 ? (
              <p style={{ fontSize: 13, margin: "4px 0 0" }}>
                {suggestedBans.map((b) => b.name).join(", ")}
              </p>
            ) : (
              <p
                style={{
                  fontSize: 13,
                  margin: "4px 0 0",
                  color: "var(--muted)",
                }}
              >
                No ban meaningfully improves this matchup.
              </p>
            )}
          </div>

          {resp.explanationLines.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={sectionHeading}>Why this lineup</h3>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {resp.explanationLines.map((line, i) => (
                  <li key={i} style={{ fontSize: 13, marginTop: 2 }}>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {!resp && !error && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading data…</p>
      )}
    </aside>
  );
}

function WinBar({ p }: { p: number }) {
  const pct = Math.round(p * 1000) / 10;
  const color =
    p >= 0.55 ? "var(--tier-a)" : p >= 0.45 ? "var(--tier-b)" : "var(--enemy)";
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
        }}
      >
        <span style={{ color: "var(--muted)" }}>Estimated win probability</span>
        <span style={{ fontWeight: 700 }}>{pct.toFixed(1)}%</span>
      </div>
      <div style={barTrack}>
        <div style={{ ...barFill, width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function roleColor(role: string): string {
  return role === "Vanguard"
    ? "var(--role-vang)"
    : role === "Duelist"
      ? "var(--role-duel)"
      : "var(--role-strat)";
}

/* styles */

const panel: CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 16,
  position: "sticky",
  top: 12,
  maxHeight: "calc(100vh - 24px)",
  overflow: "auto",
  transition: "opacity 120ms",
};

const slotRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--chip)",
  borderRadius: 8,
  padding: "6px 10px",
};

const rolePill: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text)",
  flexShrink: 0,
};

const lockTag: CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--my)",
  border: "1px solid var(--my)",
  borderRadius: 999,
  padding: "1px 7px",
};

const sectionHeading: CSSProperties = {
  margin: 0,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--muted-strong)",
};

const banButton: CSSProperties = {
  marginTop: 4,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--chip)",
  color: "var(--text)",
  fontSize: 13,
};

const barTrack: CSSProperties = {
  height: 8,
  borderRadius: 999,
  background: "var(--chip)",
  marginTop: 4,
  overflow: "hidden",
};

const barFill: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  transition: "width 200ms",
};
