"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { Hero } from "./local-api";

/**
 * Single hero board. Clicking a hero assigns it to the active bucket
 * (my team / enemy team / bans); clicking again removes it. Membership is
 * shown in place, so there's one grid instead of four.
 */

export type Bucket = "my" | "enemy" | "ban";

export type Membership = Record<string, Bucket | undefined>;

const ROLE_ORDER = ["Vanguard", "Duelist", "Strategist"] as const;
const TIER_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };

type Props = {
  heroes: Hero[];
  membership: Membership;
  onToggle: (id: string) => void;
  warn: Record<string, number>;
  warnWhy: Record<string, string>;
};

export default function HeroGrid({
  heroes,
  membership,
  onToggle,
  warn,
  warnWhy,
}: Props) {
  const [q, setQ] = useState("");

  const byRole = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = heroes.filter((h) =>
      needle
        ? h.name.toLowerCase().includes(needle) || h.id.includes(needle)
        : true,
    );
    return ROLE_ORDER.map((role) => ({
      role,
      heroes: filtered
        .filter((h) => h.role === role)
        .sort((a, b) => {
          const t = (TIER_ORDER[tierOf(a)] ?? 9) - (TIER_ORDER[tierOf(b)] ?? 9);
          return t !== 0 ? t : a.name.localeCompare(b.name);
        }),
    })).filter((g) => g.heroes.length > 0);
  }, [heroes, q]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search heroes…"
        aria-label="Search heroes"
        style={search}
      />
      {byRole.map(({ role, heroes: group }) => (
        <section key={role} style={{ marginBottom: 18 }}>
          <h3 style={roleHeading}>
            <span style={{ ...roleDot, background: roleColor(role) }} />
            {role}s
          </h3>
          <div style={grid}>
            {group.map((h) => {
              const bucket = membership[h.id];
              const threat = warn[h.id] ?? 1;
              const isWarn = threat >= 1.25 && bucket !== "enemy";
              return (
                <button
                  key={h.id}
                  onClick={() => onToggle(h.id)}
                  aria-label={`${h.name}${bucket ? ` (${bucketLabel(bucket)})` : ""}`}
                  title={
                    isWarn
                      ? (warnWhy[h.id] ?? "Countered by enemy pick")
                      : undefined
                  }
                  style={{
                    ...card,
                    borderColor: bucket ? bucketColor(bucket) : "var(--border)",
                    borderStyle: bucket === "ban" ? "dashed" : "solid",
                    boxShadow: bucket
                      ? `0 0 0 1px ${bucketColor(bucket)}`
                      : "none",
                    opacity: bucket === "ban" ? 0.55 : 1,
                  }}
                >
                  <span style={cardTop}>
                    <span style={name}>{h.name}</span>
                    <span
                      style={{ ...tierBadge, background: tierColor(tierOf(h)) }}
                    >
                      {tierOf(h)}
                    </span>
                  </span>
                  <span style={cardBottom}>
                    {bucket ? (
                      <span
                        style={{
                          ...bucketTag,
                          background: bucketColor(bucket),
                        }}
                      >
                        {bucketLabel(bucket)}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        &nbsp;
                      </span>
                    )}
                    {isWarn && (
                      <span
                        style={warnDot}
                        aria-label="Countered by an enemy pick"
                      >
                        ⚠
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function tierOf(h: Hero): string {
  return h.tags.find((t) => t.startsWith("tier:"))?.split(":")[1] ?? "-";
}

function bucketLabel(b: Bucket): string {
  return b === "my" ? "My team" : b === "enemy" ? "Enemy" : "Banned";
}

function bucketColor(b: Bucket): string {
  return b === "my"
    ? "var(--my)"
    : b === "enemy"
      ? "var(--enemy)"
      : "var(--muted-border)";
}

function roleColor(role: string): string {
  return role === "Vanguard"
    ? "var(--role-vang)"
    : role === "Duelist"
      ? "var(--role-duel)"
      : "var(--role-strat)";
}

function tierColor(tier: string): string {
  return tier === "S"
    ? "var(--tier-s)"
    : tier === "A"
      ? "var(--tier-a)"
      : tier === "B"
        ? "var(--tier-b)"
        : tier === "C"
          ? "var(--tier-c)"
          : "var(--tier-d)";
}

/* styles */

const search: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  marginBottom: 14,
  fontSize: 14,
};

const roleHeading: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--muted-strong)",
  margin: "0 0 8px",
};

const roleDot: CSSProperties = { width: 10, height: 10, borderRadius: 999 };

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: 8,
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  textAlign: "left",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "8px 10px",
  color: "var(--text)",
};

const cardTop: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 6,
};

const name: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tierBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "#fff",
  borderRadius: 999,
  padding: "1px 7px",
  flexShrink: 0,
};

const cardBottom: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  minHeight: 18,
};

const bucketTag: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#fff",
  borderRadius: 999,
  padding: "1px 8px",
};

const warnDot: CSSProperties = { fontSize: 12 };
