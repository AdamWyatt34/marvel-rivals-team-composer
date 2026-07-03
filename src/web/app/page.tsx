"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import HeroGrid, { type Bucket, type Membership } from "./HeroGrid";
import ResultsPanel from "./ResultsPanel";
import {
  composeTeam,
  getHeroes,
  getMaps,
  getSnapshotMeta,
  getThreatsDetailed,
  suggestBansFor,
  type ComposeResponse,
  type Hero,
  type MapItem,
  type SnapshotMeta,
} from "./local-api";
import { TIER_BANDS, type TierBand } from "../lib/engine";

const BAND_LABELS: Record<TierBand, string> = {
  all: "All ranks",
  "gold+": "Gold+",
  "platinum+": "Platinum+",
  "diamond+": "Diamond+",
  "grandmaster+": "Grandmaster+",
};

const BUCKET_LIMITS: Record<Bucket, number> = { my: 6, enemy: 6, ban: 8 };

export default function Home() {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [maps, setMaps] = useState<MapItem[]>([]);
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);

  const [my, setMy] = useState<string[]>([]);
  const [enemy, setEnemy] = useState<string[]>([]);
  const [bans, setBans] = useState<string[]>([]);
  const [selectedMap, setSelectedMap] = useState<string | undefined>(undefined);
  // Default to Platinum+ — the "all" band is dominated by low-rank data.
  const [band, setBand] = useState<TierBand>("platinum+");
  const [mode, setMode] = useState<Bucket>("my");

  const [resp, setResp] = useState<ComposeResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<Record<string, number>>({});
  const [warnWhy, setWarnWhy] = useState<Record<string, string>>({});
  const [suggestedBans, setSuggestedBans] = useState<
    { id: string; name: string }[] | null
  >(null);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    getMaps()
      .then(setMaps)
      .catch(() => setMaps([]));
    getSnapshotMeta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  useEffect(() => {
    getHeroes(band)
      .then(setAllHeroes)
      .catch((e) => setError(String(e)));
  }, [band]);

  useEffect(() => {
    getThreatsDetailed(enemy, band)
      .then((map) => {
        const w: Record<string, number> = {};
        const why: Record<string, string> = {};
        for (const [heroId, entry] of Object.entries(map)) {
          w[heroId] = entry.mult ?? 1;
          if (entry.by && entry.by.mult > 1) {
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

  // Live composition: debounce, keep the previous result while updating.
  const composeSeq = useRef(0);
  useEffect(() => {
    const seq = ++composeSeq.current;
    setPending(true);
    setSuggestedBans(null);
    const timer = setTimeout(async () => {
      try {
        const r = await composeTeam({
          myLocked: my,
          enemyLocked: enemy,
          bans,
          map: selectedMap,
          band,
        });
        if (composeSeq.current === seq) {
          setResp(r);
          setError(null);
        }
      } catch (e) {
        if (composeSeq.current === seq) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (composeSeq.current === seq) setPending(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [my, enemy, bans, selectedMap, band]);

  const membership = useMemo<Membership>(() => {
    const m: Membership = {};
    for (const id of bans) m[id] = "ban";
    for (const id of enemy) m[id] = "enemy";
    for (const id of my) m[id] = "my";
    return m;
  }, [my, enemy, bans]);

  function toggleHero(id: string) {
    const current = membership[id];
    const remove = (list: string[]) => list.filter((x) => x !== id);
    // Clicking a hero already in the active bucket removes it; otherwise it
    // moves to the active bucket (respecting its limit).
    setMy((l) => remove(l));
    setEnemy((l) => remove(l));
    setBans((l) => remove(l));
    if (current === mode) return;
    const setter =
      mode === "my" ? setMy : mode === "enemy" ? setEnemy : setBans;
    setter((l) => (l.length >= BUCKET_LIMITS[mode] ? l : [...l, id]));
  }

  async function onSuggestBans() {
    setSuggesting(true);
    try {
      // Yield a frame so the button state paints before the sync search.
      await new Promise((r) => setTimeout(r, 0));
      setSuggestedBans(
        await suggestBansFor({
          myLocked: my,
          enemyLocked: enemy,
          bans,
          map: selectedMap,
          band,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  }

  function clearAll() {
    setMy([]);
    setEnemy([]);
    setBans([]);
    setSuggestedBans(null);
  }

  const updatedAgo = meta ? timeAgo(meta.updatedAt) : null;

  return (
    <main style={page}>
      <header style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Marvel Rivals Team Composer</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
          Mark your locked picks, the enemy&apos;s picks, and any bans — the
          ideal team updates live.
          {meta && (
            <>
              {" "}
              Data: {meta.seasonLabel}
              {updatedAgo ? `, updated ${updatedAgo}` : ""} (rivalsmeta.com).
            </>
          )}
        </p>
      </header>

      <div style={controlBar}>
        <div style={segmented} role="group" aria-label="Assignment mode">
          {(["my", "enemy", "ban"] as const).map((b) => (
            <button
              key={b}
              onClick={() => setMode(b)}
              aria-pressed={mode === b}
              style={{
                ...segBtn,
                background: mode === b ? segColor(b) : "transparent",
                color: mode === b ? "#fff" : "var(--text)",
              }}
            >
              {b === "my"
                ? `My team (${my.length}/6)`
                : b === "enemy"
                  ? `Enemy (${enemy.length}/6)`
                  : `Bans (${bans.length})`}
            </button>
          ))}
        </div>

        <select
          value={selectedMap ?? ""}
          onChange={(e) => setSelectedMap(e.target.value || undefined)}
          aria-label="Select map"
          style={select}
        >
          <option value="">Any map</option>
          {maps.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <select
          value={band}
          onChange={(e) => setBand(e.target.value as TierBand)}
          aria-label="Select rank band"
          style={select}
        >
          {(Object.keys(TIER_BANDS) as TierBand[]).map((b) => (
            <option key={b} value={b}>
              {BAND_LABELS[b]}
            </option>
          ))}
        </select>

        <button onClick={clearAll} style={clearBtn}>
          Clear
        </button>
      </div>

      <div className="layout">
        <section style={{ minWidth: 0 }}>
          <HeroGrid
            heroes={allHeroes}
            membership={membership}
            onToggle={toggleHero}
            warn={warn}
            warnWhy={warnWhy}
          />
        </section>

        <ResultsPanel
          resp={resp}
          pending={pending}
          error={error}
          lockedIds={my}
          suggestedBans={suggestedBans}
          suggesting={suggesting}
          onSuggestBans={onSuggestBans}
          canSuggestBans={true}
        />
      </div>

      <style jsx>{`
        .layout {
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 16px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .layout {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}

function segColor(b: Bucket): string {
  return b === "my"
    ? "var(--my)"
    : b === "enemy"
      ? "var(--enemy)"
      : "var(--muted-strong)";
}

function timeAgo(iso: string): string {
  const hours = Math.max(
    0,
    Math.round((Date.now() - Date.parse(iso)) / 3_600_000),
  );
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* styles */

const page: CSSProperties = {
  padding: "20px 24px 40px",
  maxWidth: 1200,
  margin: "0 auto",
  background: "var(--bg)",
  color: "var(--text)",
  minHeight: "100vh",
};

const controlBar: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  position: "sticky",
  top: 0,
  zIndex: 10,
  background: "color-mix(in oklab, var(--bg) 85%, transparent)",
  backdropFilter: "blur(8px)",
  padding: "10px 0",
  marginBottom: 12,
  borderBottom: "1px solid var(--border)",
};

const segmented: CSSProperties = {
  display: "flex",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
  background: "var(--card)",
};

const segBtn: CSSProperties = {
  padding: "8px 12px",
  border: "none",
  fontSize: 13,
  fontWeight: 600,
};

const select: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  fontSize: 13,
};

const clearBtn: CSSProperties = {
  marginLeft: "auto",
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--chip)",
  color: "var(--text)",
  fontSize: 13,
};
