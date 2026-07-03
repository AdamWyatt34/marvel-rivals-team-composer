"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { getHeroDossier, type Hero, type HeroDossier } from "./local-api";
import type { TierBand } from "../lib/engine";

/**
 * Single hero board. Clicking a hero assigns it to the active bucket
 * (my team / enemy team / bans); clicking again removes it. In Enemy mode
 * heroes sort by how likely the enemy is to field them. Enter in the search
 * box locks the top match into the active bucket.
 */

export type Bucket = "my" | "enemy" | "ban";

export type Membership = Record<string, Bucket | undefined>;

const ROLE_ORDER = ["Vanguard", "Duelist", "Strategist"] as const;
const TIER_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };

type Props = {
  heroes: Hero[];
  membership: Membership;
  mode: Bucket;
  onToggle: (id: string) => void;
  warn: Record<string, number>;
  warnWhy: Record<string, string>;
  /** heroId -> team-up name this hero would complete with the current locks */
  completes: Record<string, string>;
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  band: TierBand;
  mapId?: string | null;
};

type DossierState = Record<string, HeroDossier | "loading" | undefined>;

export default function HeroGrid({
  heroes,
  membership,
  mode,
  onToggle,
  warn,
  warnWhy,
  completes,
  favorites,
  onToggleFavorite,
  band,
  mapId,
}: Props) {
  const [q, setQ] = useState("");
  const [openDossier, setOpenDossier] = useState<string | null>(null);
  const [dossiers, setDossiers] = useState<DossierState>({});
  const searchRef = useRef<HTMLInputElement>(null);

  // dossier facts depend on band + map; drop the cache when they change
  useEffect(() => {
    setDossiers({});
    setOpenDossier(null);
  }, [band, mapId]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return heroes.filter((h) =>
      needle
        ? h.name.toLowerCase().includes(needle) || h.id.includes(needle)
        : true,
    );
  }, [heroes, q]);

  const byRole = useMemo(() => {
    const sortFor = (a: Hero, b: Hero) => {
      if (mode === "enemy") {
        // most likely enemy picks first
        return b.pickShare + 3 * b.banRate - (a.pickShare + 3 * a.banRate);
      }
      const favDiff =
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id));
      if (favDiff !== 0) return favDiff;
      const t = (TIER_ORDER[tierOf(a)] ?? 9) - (TIER_ORDER[tierOf(b)] ?? 9);
      return t !== 0 ? t : a.name.localeCompare(b.name);
    };
    return ROLE_ORDER.map((role) => ({
      role,
      heroes: filtered.filter((h) => h.role === role).sort(sortFor),
    })).filter((g) => g.heroes.length > 0);
  }, [filtered, mode, favoriteSet]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const first = byRole[0]?.heroes[0];
    if (first != null && q.trim().length > 0) {
      onToggle(first.id);
      setQ("");
    }
  };

  const toggleDossier = (id: string) => {
    const next = openDossier === id ? null : id;
    setOpenDossier(next);
    if (next != null && dossiers[next] == null) {
      setDossiers((d) => ({ ...d, [next]: "loading" }));
      getHeroDossier(next, band, mapId)
        .then((dossier) => setDossiers((d) => ({ ...d, [next]: dossier })))
        .catch(() => setDossiers((d) => ({ ...d, [next]: undefined })));
    }
  };

  return (
    <div>
      <input
        ref={searchRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onSearchKey}
        placeholder="Search heroes… (Enter locks the top match)"
        aria-label="Search heroes"
        style={search}
      />
      {byRole.map(({ role, heroes: group }) => (
        <section key={role} style={{ marginBottom: 18 }}>
          <h3 style={roleHeading} className="role-heading">
            <span style={{ ...roleDot, background: roleColor(role) }} />
            {role}s
          </h3>
          <div style={grid}>
            {group.map((h) => {
              const bucket = membership[h.id];
              const threat = warn[h.id] ?? 1;
              const isWarn = threat >= 1.25 && bucket !== "enemy";
              const isFav = favoriteSet.has(h.id);
              const dossier = openDossier === h.id ? dossiers[h.id] : undefined;
              return (
                <div
                  key={h.id}
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  <div
                    className="hero-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`${h.name}${bucket ? ` (${bucketLabel(bucket)})` : ""}`}
                    onClick={() => onToggle(h.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggle(h.id);
                      }
                    }}
                    title={
                      isWarn
                        ? (warnWhy[h.id] ?? "Countered by enemy pick")
                        : undefined
                    }
                    style={{
                      ...card,
                      borderColor: bucket
                        ? bucketColor(bucket)
                        : "var(--border)",
                      borderStyle: bucket === "ban" ? "dashed" : "solid",
                      boxShadow: bucket
                        ? `0 0 0 1px ${bucketColor(bucket)}`
                        : "none",
                      opacity: bucket === "ban" ? 0.55 : 1,
                    }}
                  >
                    <span style={cardTop}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(h.id);
                        }}
                        aria-label={
                          isFav ? `Unfavorite ${h.name}` : `Favorite ${h.name}`
                        }
                        title={isFav ? "In my pool" : "Add to my pool"}
                        style={{
                          ...starBtn,
                          color: isFav ? "#eab308" : "var(--muted-border)",
                        }}
                      >
                        {isFav ? "★" : "☆"}
                      </button>
                      <span style={name}>{h.name}</span>
                      <span
                        style={{
                          ...tierBadge,
                          background: tierColor(tierOf(h)),
                        }}
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
                      ) : completes[h.id] != null ? (
                        <span
                          style={teamUpHint}
                          title={`Completes the ${completes[h.id]} team-up with your current picks`}
                        >
                          ⚡ {titleCase(completes[h.id])}
                        </span>
                      ) : (
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>
                          &nbsp;
                        </span>
                      )}
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {isWarn && (
                          <span
                            style={warnDot}
                            aria-label="Countered by an enemy pick"
                          >
                            ⚠
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDossier(h.id);
                          }}
                          aria-label={`Details for ${h.name}`}
                          style={infoBtn}
                        >
                          ⓘ
                        </button>
                      </span>
                    </span>
                  </div>
                  {openDossier === h.id && (
                    <DossierBox dossier={dossier} mapSelected={mapId != null} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function DossierBox({
  dossier,
  mapSelected,
}: {
  dossier: HeroDossier | "loading" | undefined;
  mapSelected: boolean;
}) {
  if (dossier == null || dossier === "loading") {
    return <div style={dossierBox}>Loading…</div>;
  }
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const edgePct = (edge: number) =>
    `${edge > 0 ? "+" : ""}${(edge * 25).toFixed(0)}`;
  return (
    <div style={dossierBox}>
      <div>
        <strong>Win rate:</strong>{" "}
        {dossier.winRate != null ? pct(dossier.winRate) : "—"}
        {" · "}
        <strong>Picked:</strong>{" "}
        {dossier.pickShare != null ? pct(dossier.pickShare) : "—"}
        {" · "}
        <strong>Banned:</strong> {pct(dossier.banRate)}
      </div>
      {dossier.beats.length > 0 && (
        <div>
          <strong>Beats:</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            {dossier.beats.map((e) => e.name).join(", ")}
          </span>
        </div>
      )}
      {dossier.losesTo.length > 0 && (
        <div>
          <strong>Loses to:</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            {dossier.losesTo.map((e) => e.name).join(", ")}
          </span>
        </div>
      )}
      {dossier.teamUpPartners.length > 0 && (
        <div>
          <strong>Team-ups with:</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            {dossier.teamUpPartners.join(", ")}
          </span>
        </div>
      )}
      {dossier.pairPartners.length > 0 && (
        <div>
          <strong>Plays well with:</strong>{" "}
          <span style={{ color: "var(--muted)" }}>
            {dossier.pairPartners.map((p) => p.name).join(", ")}
          </span>
        </div>
      )}
      {mapSelected && dossier.mapDelta != null && dossier.mapDelta !== 0 && (
        <div>
          <strong>This map:</strong>{" "}
          <span
            style={{
              color: dossier.mapDelta > 0 ? "var(--tier-a)" : "var(--enemy)",
            }}
          >
            {edgePct(dossier.mapDelta)}% vs their average
          </span>
        </div>
      )}
    </div>
  );
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
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
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
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
  cursor: "pointer",
};

const cardTop: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const name: CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  flex: 1,
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
  minHeight: 20,
};

const bucketTag: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "#fff",
  borderRadius: 999,
  padding: "1px 8px",
};

const warnDot: CSSProperties = { fontSize: 12 };

const teamUpHint: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--accent)",
  border: "1px solid color-mix(in oklab, var(--accent) 45%, transparent)",
  borderRadius: 999,
  padding: "1px 7px",
  maxWidth: 110,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const starBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  cursor: "pointer",
};

const infoBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--muted)",
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
  cursor: "pointer",
};

const dossierBox: CSSProperties = {
  border: "1px dashed var(--border)",
  borderRadius: 10,
  padding: "8px 10px",
  fontSize: 12,
  background: "var(--chip)",
  display: "flex",
  flexDirection: "column",
  gap: 3,
};
