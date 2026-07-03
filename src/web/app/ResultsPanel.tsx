"use client";

import { useState, type CSSProperties } from "react";
import type { ComposeResponse, SlotAlternative } from "./local-api";

type BanSuggestions = {
  list: { id: string; name: string }[] | null;
  loading: boolean;
};

type Props = {
  resp: ComposeResponse | null;
  pending: boolean;
  error: string | null;
  lockedIds: string[];
  pinnedIds: string[];
  alternatives: Record<string, SlotAlternative[] | "loading">;
  onExpandSlot: (heroId: string) => void;
  onPin: (altId: string, displacedId: string) => void;
  onUnpin: (heroId: string) => void;
  onClearPins: () => void;
  banSuggestions: BanSuggestions;
  onAddBan: (heroId: string) => void;
};

const ROLE_ORDER = ["Vanguard", "Duelist", "Strategist"];

export default function ResultsPanel({
  resp,
  pending,
  error,
  lockedIds,
  pinnedIds,
  alternatives,
  onExpandSlot,
  onPin,
  onUnpin,
  onClearPins,
  banSuggestions,
  onAddBan,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const toggleSlot = (heroId: string, locked: boolean) => {
    if (locked) return;
    const next = expanded === heroId ? null : heroId;
    setExpanded(next);
    if (next != null) onExpandSlot(next);
  };

  const body = (
    <>
      {error && (
        <p
          style={{
            color: "var(--enemy)",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
          {pinnedIds.length > 0 && (
            <button onClick={onClearPins} style={inlineLink}>
              Clear pins
            </button>
          )}
        </p>
      )}

      {resp && !error && (
        <>
          <WinBar
            p={resp.winProbability}
            low={resp.winProbabilityLow}
            high={resp.winProbabilityHigh}
          />

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
              .map((slot) => {
                const isLocked = lockedIds.includes(slot.id);
                const isPinned = pinnedIds.includes(slot.id);
                const isExpanded = expanded === slot.id;
                const alts = alternatives[slot.id];
                return (
                  <div key={slot.id}>
                    <div
                      style={{
                        ...slotRow,
                        cursor: isLocked ? "default" : "pointer",
                      }}
                      onClick={() => toggleSlot(slot.id, isLocked)}
                      role={isLocked ? undefined : "button"}
                      aria-expanded={isLocked ? undefined : isExpanded}
                      title={
                        isLocked ? undefined : "See alternatives for this slot"
                      }
                    >
                      <span
                        style={{
                          ...rolePill,
                          background: roleColor(slot.role),
                        }}
                      >
                        {slot.role[0]}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        {slot.name}
                      </span>
                      {isLocked && <span style={lockTag}>locked</span>}
                      {isPinned && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onUnpin(slot.id);
                          }}
                          style={pinTag}
                          title="Unpin"
                        >
                          pinned ×
                        </button>
                      )}
                      {!isLocked && !isPinned && (
                        <span
                          style={{
                            marginLeft: "auto",
                            color: "var(--muted)",
                            fontSize: 11,
                          }}
                        >
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      )}
                    </div>
                    {isExpanded && (
                      <div style={altBox}>
                        {alts === "loading" || alts == null ? (
                          <span style={{ color: "var(--muted)", fontSize: 12 }}>
                            Comparing…
                          </span>
                        ) : alts.length === 0 ? (
                          <span style={{ color: "var(--muted)", fontSize: 12 }}>
                            No same-role alternatives available.
                          </span>
                        ) : (
                          alts.map((alt) => (
                            <button
                              key={alt.id}
                              onClick={() => {
                                setExpanded(null);
                                onPin(alt.id, slot.id);
                              }}
                              style={altButton}
                              title={`Swap in ${alt.name}`}
                            >
                              {alt.name}{" "}
                              <span
                                style={{
                                  color:
                                    alt.deltaProb >= 0
                                      ? "var(--tier-a)"
                                      : "var(--enemy)",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                {alt.deltaProb >= 0 ? "+" : ""}
                                {(alt.deltaProb * 100).toFixed(1)}%
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>

          {pinnedIds.length > 0 && (
            <button
              onClick={onClearPins}
              style={{ ...inlineLink, marginTop: 6 }}
            >
              Clear all pins
            </button>
          )}

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
            <h3 style={sectionHeading}>Ban suggestions</h3>
            {banSuggestions.loading ? (
              <p
                style={{
                  fontSize: 13,
                  margin: "4px 0 0",
                  color: "var(--muted)",
                }}
              >
                Searching for impactful bans…
              </p>
            ) : banSuggestions.list == null ? (
              <p
                style={{
                  fontSize: 13,
                  margin: "4px 0 0",
                  color: "var(--muted)",
                }}
              >
                Lock at least one hero to get ban suggestions.
              </p>
            ) : banSuggestions.list.length === 0 ? (
              <p
                style={{
                  fontSize: 13,
                  margin: "4px 0 0",
                  color: "var(--muted)",
                }}
              >
                No ban meaningfully improves this matchup.
              </p>
            ) : (
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginTop: 4,
                }}
              >
                {banSuggestions.list.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => onAddBan(b.id)}
                    style={banChip}
                    title={`Add ${b.name} to bans`}
                  >
                    + {b.name}
                  </button>
                ))}
              </div>
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
    </>
  );

  return (
    <>
      <aside
        className={`results-panel ${sheetOpen ? "open" : ""}`}
        style={{ opacity: pending ? 0.7 : 1 }}
        id="results"
        aria-live="polite"
      >
        <button
          className="sheet-toggle"
          onClick={() => setSheetOpen((v) => !v)}
          aria-expanded={sheetOpen}
        >
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            Recommended team
            {resp && !error
              ? ` · ${(resp.winProbability * 100).toFixed(0)}%`
              : ""}
          </span>
          <span>{sheetOpen ? "▾" : "▴"}</span>
        </button>
        <div className="sheet-body">
          <div
            style={{ display: "flex", alignItems: "baseline", gap: 8 }}
            className="panel-title"
          >
            <h2 style={{ margin: 0, fontSize: 18 }}>Recommended team</h2>
            {pending && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                updating…
              </span>
            )}
          </div>
          {body}
        </div>
      </aside>

      <style jsx>{`
        .results-panel {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 16px;
          position: sticky;
          top: 110px;
          max-height: calc(100vh - 122px);
          overflow: auto;
          transition: opacity 120ms;
          box-shadow:
            0 1px 2px rgba(0, 0, 0, 0.05),
            0 8px 24px rgba(0, 0, 0, 0.06);
        }
        .sheet-toggle {
          display: none;
        }
        @media (max-width: 900px) {
          .results-panel {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            top: auto;
            z-index: 30;
            border-radius: 14px 14px 0 0;
            padding: 0 16px 16px;
            max-height: 40px;
            overflow: hidden;
            box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.25);
          }
          .results-panel.open {
            max-height: 75vh;
            overflow: auto;
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
          }
          .sheet-toggle {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            background: transparent;
            border: none;
            color: var(--text);
            padding: 10px 0;
            min-height: 40px;
          }
          .panel-title {
            display: none !important;
          }
        }
      `}</style>
    </>
  );
}

function WinBar({ p, low, high }: { p: number; low: number; high: number }) {
  const pct = (x: number) => x * 100;
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
        <span style={{ fontWeight: 700 }}>
          {pct(low).toFixed(0)}–{pct(high).toFixed(0)}%
        </span>
      </div>
      <div style={barTrack}>
        {/* uncertainty band behind the point estimate */}
        <div
          style={{
            position: "absolute",
            left: `${pct(low)}%`,
            width: `${Math.max(1, pct(high) - pct(low))}%`,
            height: "100%",
            background: "color-mix(in oklab, var(--tier-b) 30%, transparent)",
          }}
        />
        <div className="win-fill" style={{ ...barFill, width: `${pct(p)}%` }} />
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

const pinTag: CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--tier-a)",
  border: "1px solid var(--tier-a)",
  background: "transparent",
  borderRadius: 999,
  padding: "1px 7px",
};

const altBox: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  padding: "8px 10px",
  border: "1px dashed var(--border)",
  borderRadius: 8,
  marginTop: 4,
};

const altButton: CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
};

const banChip: CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 999,
  border: "1px dashed var(--muted-border)",
  background: "var(--chip)",
  color: "var(--text)",
};

const sectionHeading: CSSProperties = {
  margin: 0,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--muted-strong)",
};

const inlineLink: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--my)",
  fontSize: 12,
  textDecoration: "underline",
  padding: 0,
  marginLeft: 8,
};

const barTrack: CSSProperties = {
  position: "relative",
  height: 8,
  borderRadius: 999,
  background: "var(--chip)",
  marginTop: 4,
  overflow: "hidden",
};

const barFill: CSSProperties = {
  position: "relative",
  height: "100%",
  borderRadius: 999,
  transition: "width 200ms",
};
