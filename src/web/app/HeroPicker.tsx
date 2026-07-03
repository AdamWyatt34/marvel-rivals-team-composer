"use client";

import React, {
  useMemo,
  useState,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import type { Hero } from "./local-api";
import { getHeroDetails } from "./local-api";

type HighlightKind = "my" | "enemy" | "myban" | "enemyban";

type Props = {
  label: string;
  allHeroes: Hero[];
  selected: string[];
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  setSelected: (ids: string[]) => void;
  limit?: number;
  highlight?: Record<string, HighlightKind>;
  warn?: Record<string, number>; // heroId -> max enemy counter multiplier
  warnWhy?: Record<string, string>; // heroId -> reason text (optional)
};

const ROLES = ["All", "Strategist", "Vanguard", "Duelist"] as const;
type RoleTab = (typeof ROLES)[number];

type DetailsMap = Record<
  string,
  {
    loading: boolean;
    data?: {
      topCounters: string[];
      topThreats: string[];
      topSynergies: string[];
    };
  }
>;

export default function HeroPicker({
  label,
  allHeroes,
  selected,
  setSelected,
  limit,
  highlight = {},
  warn = {},
  warnWhy = {},
}: Props) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState<RoleTab>("All");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<DetailsMap>({});

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allHeroes
      .filter((h) => role === "All" || h.role === role)
      .filter((h) =>
        needle
          ? h.name.toLowerCase().includes(needle) || h.id.includes(needle)
          : true,
      );
  }, [allHeroes, q, role]);

  function toggle(id: string) {
    if (selected.includes(id)) setSelected(selected.filter((x) => x !== id));
    else if (!limit || selected.length < limit) setSelected([...selected, id]);
  }

  return (
    <section style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 16 }}>
          {label} ({selected.length}
          {limit ? `/${limit}` : ""})
        </strong>

        {/* Role filter */}
        <div style={{ display: "flex", gap: 4 }}>
          {ROLES.map((r) => (
            <button key={r} onClick={() => setRole(r)} style={pill(role === r)}>
              {r}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or id…"
          style={{
            marginLeft: "auto",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            minWidth: 220,
          }}
        />
      </div>

      {/* Selected chips */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 8,
          minHeight: 28,
        }}
      >
        {selected.length === 0 ? (
          <span style={{ color: "var(--muted)" }}>—</span>
        ) : (
          selected.map((id) => {
            const h = allHeroes.find((x) => x.id === id);
            const name = h?.name ?? id;
            return (
              <span key={id} style={chipStyle}>
                {name}
                <button
                  onClick={() => toggle(id)}
                  aria-label={`Remove ${name}`}
                  style={chipX}
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Grid */}
      <div style={gridWrap} className="hero-grid">
        {filtered.map((h) => {
          const isPicked = selected.includes(h.id);
          const hl = highlight[h.id];
          const border =
            hl === "my"
              ? "2px solid var(--my)"
              : hl === "enemy"
                ? "2px solid var(--enemy)"
                : hl === "myban" || hl === "enemyban"
                  ? "2px dashed var(--muted-border)"
                  : "1px solid var(--border)";
          const faded = hl === "myban" || hl === "enemyban";
          const isOpen = !!open[h.id];

          // Warning (countered by enemy)
          const threat = warn[h.id] ?? 1.0;
          const isWarn = threat >= 1.25; // tweak threshold
          const why = warnWhy[h.id];

          // Make the card a11y-clickable without being a <button>
          const onCardClick = () => {
            if (!isPicked && !faded) toggle(h.id);
          };
          const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
            if ((e.key === "Enter" || e.key === " ") && !isPicked && !faded) {
              e.preventDefault();
              toggle(h.id);
            }
          };

          return (
            <div key={h.id} style={{ ...cardWrap }}>
              <div
                role="button"
                tabIndex={0}
                aria-label={`Select ${h.name}`}
                onClick={onCardClick}
                onKeyDown={onCardKey}
                style={{
                  ...card,
                  border,
                  opacity: faded ? 0.45 : isPicked ? 0.75 : 1,
                  position: "relative",
                  cursor: isPicked || faded ? "not-allowed" : "pointer",
                }}
                title={faded ? "Banned" : undefined}
              >
                {/* Corner tag for my/enemy/banned */}
                {hl && (
                  <span style={{ ...cornerTag, background: tagBg(hl) }}>
                    {tagText(hl)}
                  </span>
                )}

                {/* ⚠ warning dot (absolute) */}
                {isWarn && (
                  <span
                    className="warn-dot"
                    title={
                      why
                        ? `⚠ ${why}`
                        : `Countered by enemy (x${threat.toFixed(2)})`
                    }
                  />
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 700 }}>{h.name}</span>
                  <span
                    style={{
                      ...badge,
                      background: tierBg(h),
                      color: tierFg(h),
                    }}
                  >
                    {tierOf(h)}
                  </span>
                </div>

                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted-strong)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <span
                      style={{
                        ...badge,
                        background: roleBg(h.role),
                        color: roleFg(h.role),
                        border: "none",
                      }}
                    >
                      {h.role}
                    </span>
                    <span style={{ marginLeft: 8, opacity: 0.75 }}>{h.id}</span>
                  </div>

                  {/* Details chevron (true button) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen((o) => ({ ...o, [h.id]: !o[h.id] }));
                      setDetails((d) =>
                        d[h.id] ? d : { ...d, [h.id]: { loading: true } },
                      );
                      if (!details[h.id]) {
                        getHeroDetails(h.id)
                          .then((r) =>
                            setDetails((d) => ({
                              ...d,
                              [h.id]: {
                                loading: false,
                                data: {
                                  topCounters: r.topCounters,
                                  topThreats: r.topThreats,
                                  topSynergies: r.topSynergies,
                                },
                              },
                            })),
                          )
                          .catch(() =>
                            setDetails((d) => ({
                              ...d,
                              [h.id]: {
                                loading: false,
                                data: {
                                  topCounters: [],
                                  topThreats: [],
                                  topSynergies: [],
                                },
                              },
                            })),
                          );
                      }
                    }}
                    aria-label="Show details"
                    style={{
                      border: "1px solid var(--border)",
                      background: "var(--card)",
                      borderRadius: 999,
                      width: 32,
                      height: 32,
                      lineHeight: "30px",
                      fontSize: 14,
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                </div>
              </div>

              {isOpen && (
                <div style={detailsBox}>
                  {!details[h.id] || details[h.id].loading ? (
                    <div style={{ color: "var(--muted)" }}>Loading…</div>
                  ) : (
                    <>
                      <div>
                        <strong>Counters:</strong>{" "}
                        <span style={{ color: "var(--muted)" }}>
                          {details[h.id].data!.topCounters.join(", ") || "—"}
                        </span>
                      </div>
                      <div>
                        <strong>Threats:</strong>{" "}
                        <span style={{ color: "var(--muted)" }}>
                          {details[h.id].data!.topThreats.join(", ") || "—"}
                        </span>
                      </div>
                      <div>
                        <strong>Synergies:</strong>{" "}
                        <span style={{ color: "var(--muted)" }}>
                          {details[h.id].data!.topSynergies.join(", ") || "—"}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ===== styles & helpers ===== */

const pill = (active: boolean): CSSProperties => ({
  padding: "6px 10px",
  borderRadius: 8,
  border: active ? "1px solid transparent" : "1px solid var(--border)",
  background: active ? "var(--my)" : "var(--chip)",
  color: active ? "#fff" : "var(--text)",
  fontSize: 12,
  boxShadow: active
    ? "0 0 0 1px color-mix(in oklab, var(--my) 50%, transparent)"
    : "none",
});
const gridWrap: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 12,
  maxHeight: 380,
  overflowY: "auto",
  paddingRight: 6,
};

const cardWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const card: CSSProperties = {
  textAlign: "left",
  background: "var(--card)",
  borderRadius: 14,
  padding: 16,
  boxShadow: "0 1px 0 rgba(0,0,0,.03)",
};

const detailsBox: CSSProperties = {
  border: "1px dashed var(--border)",
  borderRadius: 12,
  padding: "8px 10px",
  fontSize: 12,
  background: "var(--chip)",
};

const badge: CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 999,
  border: "1px solid rgba(0,0,0,.06)",
  color: "#fff",
};

const cornerTag: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  fontSize: 10,
  padding: "2px 6px",
  borderRadius: 999,
  color: "#fff",
};

const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "var(--chip)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  padding: "4px 8px",
};

const chipX: CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  margin: 0,
};

function tierOf(h: Hero) {
  return (
    h.tags
      ?.find((t) => t.startsWith("tier:"))
      ?.split(":")[1]
      ?.toUpperCase() ?? "-"
  );
}
function tierBg(h: Hero) {
  const t = tierOf(h);
  return t === "S"
    ? "var(--tier-s)"
    : t === "A"
      ? "var(--tier-a)"
      : t === "B"
        ? "var(--tier-b)"
        : t === "C"
          ? "var(--tier-c)"
          : "var(--tier-d)";
}
function tierFg(h: Hero) {
  const t = tierOf(h);
  return t === "S" ? "var(--tier-on-dark)" : "#fff";
}
function roleBg(role: string) {
  return role === "Strategist"
    ? "var(--role-strat)"
    : role === "Vanguard"
      ? "var(--role-vang)"
      : "var(--role-duel)";
}
function roleFg(_role: string) {
  return "#fff";
}
function tagText(k: HighlightKind) {
  return k === "my" ? "My pick" : k === "enemy" ? "Enemy" : "Banned";
}
function tagBg(k: HighlightKind) {
  return k === "my"
    ? "var(--my)"
    : k === "enemy"
      ? "var(--enemy)"
      : "var(--muted-strong)";
}
