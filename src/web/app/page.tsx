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
  getBanBaitWarnings,
  getHeroes,
  getMaps,
  getSnapshotMeta,
  getTeamUpCompletions,
  getThreatsDetailed,
  slotAlternatives,
  suggestBansFor,
  type BanBaitWarning,
  type ComposePayload,
  type ComposeResponse,
  type Hero,
  type MapItem,
  type SlotAlternative,
  type SnapshotMeta,
} from "./local-api";
import { TIER_BANDS, type TierBand } from "../lib/engine";
import {
  forgetProfile,
  importProfile,
  loadStoredProfile,
  poolOf,
  profileImportEnabled,
  storeProfile,
  type ImportedHero,
} from "./profile-import";

const BAND_LABELS: Record<TierBand, string> = {
  all: "All ranks",
  "gold+": "Gold+",
  "platinum+": "Platinum+",
  "diamond+": "Diamond+",
  "grandmaster+": "Grandmaster+",
};

// 3 bans per team since Season 7 -> at most 6 unique bans per match
const BUCKET_LIMITS: Record<Bucket, number> = { my: 6, enemy: 6, ban: 6 };

type Preset = { name: string; locks: string[] };

const LS_FAVORITES = "mrtc:favorites";
const LS_PRESETS = "mrtc:presets";
const LS_POOL_ONLY = "mrtc:poolOnly";
const LS_PROFILE_UID = "mrtc:profileUid";

function readLs<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function Home() {
  const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
  const [maps, setMaps] = useState<MapItem[]>([]);
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);

  const [my, setMy] = useState<string[]>([]);
  const [enemy, setEnemy] = useState<string[]>([]);
  const [bans, setBans] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [selectedMap, setSelectedMap] = useState<string | undefined>(undefined);
  // Default to Platinum+ — the "all" band is dominated by low-rank data.
  const [band, setBand] = useState<TierBand>("platinum+");
  const [mode, setMode] = useState<Bucket>("my");

  const [favorites, setFavorites] = useState<string[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [poolOnly, setPoolOnly] = useState(false);
  const [storageReady, setStorageReady] = useState(false);

  const [resp, setResp] = useState<ComposeResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warn, setWarn] = useState<Record<string, number>>({});
  const [warnWhy, setWarnWhy] = useState<Record<string, string>>({});
  const [alternatives, setAlternatives] = useState<
    Record<string, SlotAlternative[] | "loading">
  >({});
  const [banSuggestions, setBanSuggestions] = useState<{
    list: { id: string; name: string }[] | null;
    loading: boolean;
  }>({ list: null, loading: false });
  const [banBait, setBanBait] = useState<BanBaitWarning[]>([]);
  const [completes, setCompletes] = useState<Record<string, string>>({});

  // localStorage hydration (after mount, to keep static prerender consistent)
  useEffect(() => {
    setFavorites(readLs<string[]>(LS_FAVORITES, []));
    setPresets(readLs<Preset[]>(LS_PRESETS, []));
    setPoolOnly(readLs<boolean>(LS_POOL_ONLY, false));
    try {
      setProfileUid(localStorage.getItem(LS_PROFILE_UID) ?? "");
    } catch {
      /* storage unavailable */
    }
    setProfileHeroes(loadStoredProfile()?.heroes ?? null);
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (storageReady)
      localStorage.setItem(LS_FAVORITES, JSON.stringify(favorites));
  }, [favorites, storageReady]);
  useEffect(() => {
    if (storageReady) localStorage.setItem(LS_PRESETS, JSON.stringify(presets));
  }, [presets, storageReady]);
  useEffect(() => {
    if (storageReady)
      localStorage.setItem(LS_POOL_ONLY, JSON.stringify(poolOnly));
  }, [poolOnly, storageReady]);

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

  // Shareable links: restore the draft from the query string once heroes are
  // known (so bogus slugs can't reach the engine), then mirror every change
  // back into the URL so the current board is always copyable.
  const urlReady = useRef(false);
  useEffect(() => {
    if (urlReady.current || allHeroes.length === 0) return;
    urlReady.current = true;
    const q = new URLSearchParams(window.location.search);
    const known = new Set(allHeroes.map((h) => h.id));
    const list = (key: string) =>
      (q.get(key) ?? "")
        .split(",")
        .filter((id) => known.has(id))
        .slice(0, 6);
    const myQ = list("my");
    const enemyQ = list("enemy");
    const bansQ = list("bans");
    const pinsQ = list("pins");
    if (myQ.length > 0) setMy(myQ);
    if (enemyQ.length > 0) setEnemy(enemyQ);
    if (bansQ.length > 0) setBans(bansQ);
    if (pinsQ.length > 0) setPinned(pinsQ);
    const mapQ = q.get("map");
    if (mapQ) setSelectedMap(mapQ);
    const bandQ = q.get("band");
    if (bandQ != null && bandQ in TIER_BANDS) setBand(bandQ as TierBand);
  }, [allHeroes]);

  useEffect(() => {
    if (!urlReady.current) return;
    const parts: string[] = [];
    const add = (key: string, value: string) => {
      if (value)
        parts.push(`${key}=${encodeURIComponent(value).replace(/%2C/g, ",")}`);
    };
    add("my", my.join(","));
    add("enemy", enemy.join(","));
    add("bans", bans.join(","));
    add("pins", pinned.join(","));
    add("map", selectedMap ?? "");
    add("band", band === "platinum+" ? "" : band);
    const qs = parts.join("&");
    window.history.replaceState(
      null,
      "",
      qs ? `?${qs}` : window.location.pathname,
    );
  }, [my, enemy, bans, pinned, selectedMap, band]);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileUid, setProfileUid] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileHeroes, setProfileHeroes] = useState<ImportedHero[] | null>(
    null,
  );

  function runImport() {
    const uid = profileUid.trim();
    if (uid === "" || profileBusy) return;
    setProfileBusy(true);
    setProfileMsg(null);
    importProfile(uid)
      .then((profile) => {
        const pool = poolOf(profile);
        if (pool.length === 0) {
          setProfileMsg(
            `Found ${profile.matches} matches but no hero with 3+ games — nothing to import.`,
          );
          return;
        }
        setFavorites(pool);
        setPoolOnly(true);
        setProfileHeroes(profile.heroes);
        storeProfile(profile);
        localStorage.setItem(LS_PROFILE_UID, uid);
        const top = profile.heroes
          .slice(0, 3)
          .map(
            (h) =>
              `${h.name} ${h.games}g/${Math.round((100 * h.wins) / h.games)}%`,
          )
          .join(", ");
        setProfileMsg(
          `Imported ${profile.matches} matches — pool of ${pool.length} heroes, personal records now weigh in (top: ${top}).`,
        );
      })
      .catch((e: unknown) =>
        setProfileMsg(String(e instanceof Error ? e.message : e)),
      )
      .finally(() => setProfileBusy(false));
  }

  function forgetImport() {
    forgetProfile();
    setProfileHeroes(null);
    setProfileMsg("Profile forgotten — scoring is back to band averages.");
  }

  const [copied, setCopied] = useState(false);
  function copyShareLink() {
    navigator.clipboard
      .writeText(window.location.href)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

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

  const effectiveLocks = useMemo(
    () => [...new Set([...my, ...pinned])],
    [my, pinned],
  );

  useEffect(() => {
    getTeamUpCompletions(effectiveLocks, band)
      .then(setCompletes)
      .catch(() => setCompletes({}));
  }, [effectiveLocks, band]);

  const payload = useMemo<ComposePayload>(
    () => ({
      myLocked: effectiveLocks,
      enemyLocked: enemy,
      bans,
      map: selectedMap,
      band,
      poolIds:
        poolOnly && favorites.length > 0
          ? [...new Set([...favorites, ...effectiveLocks])]
          : undefined,
      personal: profileHeroes?.map((h) => ({
        id: h.id,
        games: h.games,
        wins: h.wins,
      })),
    }),
    [
      effectiveLocks,
      enemy,
      bans,
      selectedMap,
      band,
      poolOnly,
      favorites,
      profileHeroes,
    ],
  );

  // Live composition: debounce, keep the previous result while updating.
  const composeSeq = useRef(0);
  useEffect(() => {
    const seq = ++composeSeq.current;
    setPending(true);
    setAlternatives({});
    const timer = setTimeout(async () => {
      try {
        const r = await composeTeam(payload);
        if (composeSeq.current === seq) {
          setResp(r);
          setError(null);
        }
        if (payload.myLocked.length > 0) {
          const warnings = await getBanBaitWarnings(
            payload,
            r.primary.map((p) => p.id),
          );
          if (composeSeq.current === seq) setBanBait(warnings);
        } else if (composeSeq.current === seq) {
          setBanBait([]);
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
  }, [payload]);

  // Proactive ban suggestions: after the composition settles, if you have
  // locks and open ban slots, search in the background.
  const banSeq = useRef(0);
  useEffect(() => {
    const seq = ++banSeq.current;
    if (my.length === 0 || bans.length >= BUCKET_LIMITS.ban) {
      setBanSuggestions({ list: null, loading: false });
      return;
    }
    setBanSuggestions((s) => ({ ...s, loading: true }));
    const timer = setTimeout(async () => {
      try {
        const list = await suggestBansFor(payload);
        if (banSeq.current === seq) setBanSuggestions({ list, loading: false });
      } catch {
        if (banSeq.current === seq)
          setBanSuggestions({ list: [], loading: false });
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [payload, my.length, bans.length]);

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
    setMy((l) => remove(l));
    setEnemy((l) => remove(l));
    setBans((l) => remove(l));
    setPinned((l) => remove(l));
    if (current === mode) return;
    const setter =
      mode === "my" ? setMy : mode === "enemy" ? setEnemy : setBans;
    setter((l) => (l.length >= BUCKET_LIMITS[mode] ? l : [...l, id]));
  }

  function onExpandSlot(heroId: string) {
    if (resp == null || alternatives[heroId] != null) return;
    setAlternatives((a) => ({ ...a, [heroId]: "loading" }));
    slotAlternatives(
      payload,
      resp.primary.map((p) => p.id),
      heroId,
    )
      .then((alts) => setAlternatives((a) => ({ ...a, [heroId]: alts })))
      .catch(() => setAlternatives((a) => ({ ...a, [heroId]: [] })));
  }

  function onPin(altId: string, displacedId: string) {
    setPinned((l) => [...l.filter((id) => id !== displacedId), altId]);
  }

  function clearAll() {
    setMy([]);
    setEnemy([]);
    setBans([]);
    setPinned([]);
  }

  function savePreset() {
    if (my.length === 0) return;
    const name = window.prompt("Preset name (e.g. Duo)", "Duo");
    if (!name) return;
    setPresets((p) => [
      ...p.filter((x) => x.name !== name),
      { name, locks: my },
    ]);
  }

  const updatedAgo = meta ? timeAgo(meta.updatedAt) : null;

  return (
    <main style={page}>
      <header style={{ marginBottom: 10 }}>
        <h1 className="page-title">Marvel Rivals Team Composer</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
          Mark your locked picks, the enemy&apos;s picks, and any bans — the
          ideal team updates live.
          {meta && (
            <>
              {" "}
              Data: {meta.seasonLabel}
              {updatedAgo ? `, updated ${updatedAgo}` : ""} (rivalsmeta.com).
              {meta.pairMatches > 0 &&
                ` Synergy & counters: ${meta.pairMatches.toLocaleString()} sampled top-500 ladder matches.`}
            </>
          )}
        </p>
      </header>

      <div style={controlBar} className="control-bar">
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
                  : `Bans (${bans.length}/6)`}
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

        <button
          onClick={() => setPoolOnly((v) => !v)}
          aria-pressed={poolOnly}
          disabled={favorites.length === 0}
          title={
            favorites.length === 0
              ? "Star some heroes first (☆ on the cards) to build your pool"
              : "Only recommend heroes in my pool"
          }
          style={{
            ...poolBtn,
            background: poolOnly ? "var(--my)" : "var(--chip)",
            color: poolOnly ? "#fff" : "var(--text)",
            opacity: favorites.length === 0 ? 0.5 : 1,
          }}
        >
          ★ My pool only
        </button>

        {profileImportEnabled && (
          <button
            onClick={() => setProfileOpen((v) => !v)}
            aria-expanded={profileOpen}
            style={{
              ...poolBtn,
              background: profileOpen ? "var(--my)" : "var(--chip)",
              color: profileOpen ? "#fff" : "var(--text)",
            }}
            title="Build your hero pool from your recent competitive matches"
          >
            👤 Import profile
          </button>
        )}

        <button
          onClick={copyShareLink}
          style={{ ...clearBtn, marginLeft: "auto" }}
          title="Copy a link to this exact board (locks, enemy, bans, map, rank)"
        >
          {copied ? "Copied ✓" : "🔗 Share"}
        </button>

        <button onClick={clearAll} style={{ ...clearBtn, marginLeft: 0 }}>
          Clear
        </button>
      </div>

      {profileImportEnabled && profileOpen && (
        <div style={profileRow}>
          <input
            value={profileUid}
            onChange={(e) => setProfileUid(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runImport()}
            placeholder="In-game UID (on your profile card)"
            inputMode="numeric"
            aria-label="Player UID"
            style={profileInput}
          />
          <button
            onClick={runImport}
            disabled={profileBusy || profileUid.trim() === ""}
            style={{
              ...poolBtn,
              background: "var(--my)",
              color: "#fff",
              opacity: profileBusy || profileUid.trim() === "" ? 0.5 : 1,
            }}
          >
            {profileBusy ? "Importing…" : "Import"}
          </button>
          {profileHeroes != null && (
            <button
              onClick={forgetImport}
              style={poolBtn}
              title="Drop the imported record; scoring returns to band averages"
            >
              Forget
            </button>
          )}
          {profileMsg && (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>
              {profileMsg}
            </span>
          )}
        </div>
      )}

      {(presets.length > 0 || my.length > 0) && (
        <div style={presetRow}>
          {presets.map((p) => (
            <span key={p.name} style={presetChip}>
              <button
                onClick={() => {
                  setMy(p.locks.slice(0, 6));
                  setPinned([]);
                }}
                style={presetApply}
                title={`Lock: ${p.locks.join(", ")}`}
              >
                {p.name}
              </button>
              <button
                onClick={() =>
                  setPresets((all) => all.filter((x) => x.name !== p.name))
                }
                aria-label={`Delete preset ${p.name}`}
                style={presetDelete}
              >
                ×
              </button>
            </span>
          ))}
          {my.length > 0 && (
            <button onClick={savePreset} style={presetSave}>
              + Save current locks as preset
            </button>
          )}
        </div>
      )}

      <div className="layout">
        <section style={{ minWidth: 0 }}>
          <HeroGrid
            heroes={allHeroes}
            membership={membership}
            mode={mode}
            onToggle={toggleHero}
            warn={warn}
            warnWhy={warnWhy}
            completes={completes}
            favorites={favorites}
            onToggleFavorite={(id) =>
              setFavorites((f) =>
                f.includes(id) ? f.filter((x) => x !== id) : [...f, id],
              )
            }
            band={band}
            mapId={selectedMap ?? null}
          />
        </section>

        <ResultsPanel
          resp={resp}
          pending={pending}
          error={error}
          banBait={banBait}
          lockedIds={my}
          pinnedIds={pinned}
          alternatives={alternatives}
          onExpandSlot={onExpandSlot}
          onPin={onPin}
          onUnpin={(id) => setPinned((l) => l.filter((x) => x !== id))}
          onClearPins={() => setPinned([])}
          banSuggestions={banSuggestions}
          onAddBan={(id) =>
            setBans((l) =>
              l.includes(id) || l.length >= BUCKET_LIMITS.ban ? l : [...l, id],
            )
          }
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
            padding-bottom: 56px; /* room for the bottom sheet */
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
  top: 45,
  zIndex: 10,
  background: "color-mix(in oklab, var(--bg) 85%, transparent)",
  backdropFilter: "blur(8px)",
  padding: "10px 0",
  marginBottom: 8,
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
  padding: "10px 12px",
  border: "none",
  fontSize: 13,
  fontWeight: 600,
  minHeight: 40,
};

const select: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  fontSize: 13,
  minHeight: 40,
};

const poolBtn: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  fontSize: 13,
  minHeight: 40,
};

const clearBtn: CSSProperties = {
  marginLeft: "auto",
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--chip)",
  color: "var(--text)",
  fontSize: 13,
  minHeight: 40,
};

const presetRow: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 12,
};

const profileRow: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  alignItems: "center",
  marginBottom: 12,
};

const profileInput: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--card)",
  color: "var(--text)",
  fontSize: 13,
  minHeight: 40,
  width: 260,
};

const presetChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid var(--my)",
  borderRadius: 999,
  overflow: "hidden",
};

const presetApply: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--my)",
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 4px 4px 12px",
};

const presetDelete: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--muted)",
  fontSize: 13,
  padding: "4px 10px 4px 4px",
};

const presetSave: CSSProperties = {
  background: "transparent",
  border: "1px dashed var(--border)",
  borderRadius: 999,
  color: "var(--muted-strong)",
  fontSize: 12,
  padding: "4px 12px",
};
