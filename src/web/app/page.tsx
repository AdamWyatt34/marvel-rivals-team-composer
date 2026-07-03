"use client";
import { useEffect, useMemo, useState } from "react";
import {
  composeTeam,
  ComposeResponse,
  getHeroes,
  Hero,
  getThreatsDetailed,
  MapItem,
  getMaps,
} from "./local-api";
import { TIER_BANDS, type TierBand } from "../lib/engine";
import HeroPicker from "./HeroPicker";

type HL = "my" | "enemy" | "myban" | "enemyban";

const BAND_LABELS: Record<TierBand, string> = {
  all: "All ranks",
  "gold+": "Gold+",
  "platinum+": "Platinum+",
  "diamond+": "Diamond+",
  "grandmaster+": "Grandmaster+",
};

export default function Home() {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [my, setMy] = useState<string[]>([]);
  const [enemy, setEnemy] = useState<string[]>([]);
  const [myBans, setMyBans] = useState<string[]>([]);
  const [enemyBans, setEnemyBans] = useState<string[]>([]);
  const [resp, setResp] = useState<ComposeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<Record<string, number>>({});
  const [warnWhy, setWarnWhy] = useState<Record<string, string>>({});
  const [maps, setMaps] = useState<MapItem[]>([]);
  const [selectedMap, setSelectedMap] = useState<string | undefined>(undefined);
  // Default to Platinum+ — the "all" band is dominated by low-rank data.
  const [band, setBand] = useState<TierBand>("platinum+");

  useEffect(() => {
    getMaps()
      .then(setMaps)
      .catch(() => setMaps([]));
  }, []);

  useEffect(() => {
    getHeroes(band)
      .then(setAllHeroes)
      .catch((e) => setErr(String(e)));
  }, [band]);

  useEffect(() => {
    getThreatsDetailed(enemy, band)
      .then((map) => {
        const w: Record<string, number> = {};
        const why: Record<string, string> = {};
        for (const [heroId, entry] of Object.entries(map)) {
          w[heroId] = entry.mult ?? 1.0;
          if (entry.by && entry.by.mult > 1.0) {
            why[heroId] =
              `Countered by ${entry.by.name} (x${entry.by.mult.toFixed(2)})`;
          }
        }
        setWarn(w);
        setWarnWhy(why);
      })
      .catch(() => {
        setWarn({});
        setWarnWhy({});
      });
  }, [enemy, band]);

  // Build one highlight map so all pickers show global status
  const highlight = useMemo(() => {
    const m: Record<string, HL> = {};
    for (const id of enemyBans) m[id] = "enemyban";
    for (const id of myBans) m[id] = "myban";
    for (const id of enemy) m[id] = "enemy";
    for (const id of my) m[id] = "my";
    return m;
  }, [my, enemy, myBans, enemyBans]);

  async function onCompose() {
    setErr(null);
    setResp(null);
    setBusy(true);
    // yield a frame so the "Composing…" state paints before the sync engine work
    await new Promise((r) => setTimeout(r, 0));
    try {
      const r = await composeTeam({
        myLocked: my,
        enemyLocked: enemy,
        myBans,
        enemyBans,
        map: selectedMap,
        band,
      });
      setResp(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function ContextBar({
    maps,
    selectedMap,
    setSelectedMap,
    band,
    setBand,
    busy,
    onCompose,
  }: {
    maps: MapItem[];
    selectedMap?: string;
    setSelectedMap: (v?: string) => void;
    band: TierBand;
    setBand: (b: TierBand) => void;
    busy: boolean;
    onCompose: () => void;
  }) {
    return (
      <div className="context">
        <div className="row">
          <label style={{ fontWeight: 600, marginRight: 8 }}>Map:</label>
          <select
            value={selectedMap ?? ""}
            onChange={(e) => setSelectedMap(e.target.value || undefined)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
            aria-label="Select map"
          >
            <option value="">Any</option>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <label style={{ fontWeight: 600, marginLeft: 8, marginRight: 8 }}>
            Rank:
          </label>
          <select
            value={band}
            onChange={(e) => setBand(e.target.value as TierBand)}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
            aria-label="Select rank band"
          >
            {(Object.keys(TIER_BANDS) as TierBand[]).map((b) => (
              <option key={b} value={b}>
                {BAND_LABELS[b]}
              </option>
            ))}
          </select>

          {/* light compose for desktop; sticky big button stays for mobile */}
          <button
            onClick={onCompose}
            disabled={busy}
            className="composeInline"
            aria-label="Compose team"
          >
            {busy ? "Composing…" : "Compose"}
          </button>
        </div>

        <style jsx>{`
          .context {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 10px 12px;
            margin: 8px 0 14px;
          }
          .row {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
          }
          .composeInline {
            margin-left: auto;
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--chip);
            color: var(--text);
            cursor: pointer;
          }
          @media (max-width: 900px) {
            .composeInline {
              display: none;
            } /* keep big sticky button on mobile */
          }
        `}</style>
      </div>
    );
  }

  function ResultsPanel({
    resp,
    err,
  }: {
    resp: ComposeResponse | null;
    err: string | null;
  }) {
    return (
      <aside className="results" id="results">
        <h2 style={{ marginTop: 0 }}>Results</h2>
        {!resp && !err && (
          <p style={{ color: "var(--muted)" }}>
            Run “Compose” to see recommendations.
          </p>
        )}
        {err && (
          <pre style={{ color: "#b00020", whiteSpace: "pre-wrap" }}>{err}</pre>
        )}

        {resp && (
          <>
            <p style={{ margin: "4px 0 0", fontWeight: 600 }}>
              Estimated win probability:{" "}
              {(resp.winProbability * 100).toFixed(1)}%
            </p>
            <h3>Primary Lineup</h3>
            <ul style={{ marginTop: 6 }}>
              {resp.primary.map((x, idx) => (
                <li key={idx}>
                  <strong>{x.role}</strong>: {x.hero}
                </li>
              ))}
            </ul>

            <h4>Backups per Role</h4>
            {Object.entries(resp.backups).map(([role, names]) => (
              <div key={role}>
                <strong>{role}:</strong> {names.length ? names.join(", ") : "—"}
              </div>
            ))}
            {resp.suggestedBans?.length ? (
              <p style={{ marginTop: 10 }}>
                <strong>Suggested bans:</strong> {resp.suggestedBans.join(", ")}
              </p>
            ) : null}
            {resp?.explanation && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  Why this lineup
                </summary>
                <p style={{ marginTop: 8 }}>{resp.explanation}</p>
              </details>
            )}
          </>
        )}

        <style jsx>{`
          .results {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 14px;
            position: sticky;
            top: 12px;
            max-height: calc(100vh - 24px);
            overflow: auto;
          }
          @media (max-width: 900px) {
            .results {
              position: static;
              max-height: none;
              margin-top: 16px;
            }
          }
        `}</style>
      </aside>
    );
  }

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        background: "var(--bg)",
        color: "var(--text)",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ marginBottom: 6 }}>Marvel Rivals Team Composer</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Pick up to 6 locked teammates, up to 6 enemy picks, and optional bans
        for both sides. Bans are symmetric.
      </p>

      {/* NEW: context bar with map + inline compose (desktop) */}
      <ContextBar
        maps={maps}
        selectedMap={selectedMap}
        setSelectedMap={setSelectedMap}
        band={band}
        setBand={setBand}
        busy={busy}
        onCompose={() => {
          onCompose();
          /* scroll to results on desktop */ if (window.innerWidth > 900)
            document
              .getElementById("results")
              ?.scrollIntoView({ behavior: "smooth" });
        }}
      />

      {/* 2-column responsive layout */}
      <div className="grid">
        <section className="left">
          {/* Summary bar stays */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              margin: "10px 0 18px",
            }}
          >
            <Summary
              title={`My locked (${my.length}/6)`}
              ids={my}
              allHeroes={allHeroes}
              pillColor="#2563eb"
              onRemove={(id) => setMy(my.filter((x) => x !== id))}
            />
            <Summary
              title={`Enemy locked (${enemy.length}/6)`}
              ids={enemy}
              allHeroes={allHeroes}
              pillColor="#dc2626"
              onRemove={(id) => setEnemy(enemy.filter((x) => x !== id))}
            />
            <Summary
              title={`My bans (${myBans.length})`}
              ids={myBans}
              allHeroes={allHeroes}
              pillColor="#6b7280"
              onRemove={(id) => setMyBans(myBans.filter((x) => x !== id))}
            />
            <Summary
              title={`Enemy bans (${enemyBans.length})`}
              ids={enemyBans}
              allHeroes={allHeroes}
              pillColor="#6b7280"
              onRemove={(id) => setEnemyBans(enemyBans.filter((x) => x !== id))}
            />
          </div>

          <HeroPicker
            label="My locked"
            allHeroes={allHeroes}
            selected={my}
            setSelected={setMy}
            limit={6}
            highlight={highlight}
            warn={warn}
            warnWhy={warnWhy}
          />
          <HeroPicker
            label="Enemy locked"
            allHeroes={allHeroes}
            selected={enemy}
            setSelected={setEnemy}
            limit={6}
            highlight={highlight}
            warn={warn}
            warnWhy={warnWhy}
          />
          <HeroPicker
            label="My bans"
            allHeroes={allHeroes}
            selected={myBans}
            setSelected={setMyBans}
            highlight={highlight}
            warn={warn}
            warnWhy={warnWhy}
          />
          <HeroPicker
            label="Enemy bans"
            allHeroes={allHeroes}
            selected={enemyBans}
            setSelected={setEnemyBans}
            highlight={highlight}
            warn={warn}
            warnWhy={warnWhy}
          />

          {/* Mobile quick jump to results */}
          <a href="#results" className="toResults">
            ↑ Results
          </a>
        </section>

        <ResultsPanel resp={resp} err={err} />
      </div>

      {/* Keep your sticky BottomBar for mobile */}
      <BottomBar
        busy={busy}
        onCompose={() => {
          onCompose();
          document
            .getElementById("results")
            ?.scrollIntoView({ behavior: "smooth" });
        }}
        onClear={() => {
          setResp(null);
          setErr(null);
        }}
      />

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: 1fr 360px;
          gap: 16px;
        }
        .left {
          min-width: 0;
        }
        .toResults {
          display: none;
        }
        @media (max-width: 900px) {
          .grid {
            grid-template-columns: 1fr;
          }
          .toResults {
            display: inline-block;
            margin-top: 8px;
            font-size: 12px;
            color: var(--my);
            text-decoration: none;
            border: 1px solid var(--border);
            padding: 4px 8px;
            border-radius: 999px;
            background: var(--chip);
          }
        }
      `}</style>
    </main>
  );
}

/** Small pill list used in the Summary Bar */
function Summary({
  title,
  ids,
  allHeroes,
  pillColor = "#111",
  onRemove,
}: {
  title: string;
  ids: string[];
  allHeroes: Hero[];
  pillColor?: string;
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 28 }}>
        {ids.length === 0 ? (
          <span style={{ color: "#666" }}>—</span>
        ) : (
          ids.map((id) => {
            const h = allHeroes.find((x) => x.id === id);
            const name = h?.name ?? id;
            return (
              <span
                key={id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--card)",
                  color: "var(--text)",
                  border: `1px solid ${pillColor ?? "var(--border)"}`,
                  borderRadius: 999,
                  padding: "4px 8px",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: pillColor,
                    boxShadow: `0 0 0 2px var(--card)` /* ring for contrast on dark */,
                  }}
                />
                {name}
                <button
                  onClick={() => onRemove(id)}
                  aria-label={`Remove ${name}`}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                    margin: 0,
                  }}
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

function BottomBar({
  busy,
  onCompose,
  onClear,
}: {
  busy: boolean;
  onCompose: () => void;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        zIndex: 20,
        background: "color-mix(in oklab, var(--bg) 80%, transparent)",
        backdropFilter: "saturate(1.2) blur(6px)",
        borderTop: "1px solid var(--border)",
        padding:
          "10px max(env(safe-area-inset-right),16px) calc(10px + env(safe-area-inset-bottom)) max(env(safe-area-inset-left),16px)",
        marginTop: 12,
      }}
    >
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          onClick={onClear}
          style={{
            padding: "10px 16px",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--chip)",
            color: "var(--text)",
          }}
        >
          Clear Output
        </button>

        <button
          onClick={onCompose}
          disabled={busy}
          style={{
            padding: "10px 16px",
            borderRadius: 10,
            border: "1px solid transparent",
            background: busy ? "var(--chip)" : "var(--my)",
            color: busy ? "var(--text)" : "#fff",
            opacity: busy ? 0.8 : 1,
          }}
        >
          {busy ? "Composing…" : "Compose Team"}
        </button>
      </div>
    </div>
  );
}
