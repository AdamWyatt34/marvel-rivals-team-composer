import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotSchema, type Snapshot } from "../../lib/data/schema";
import { TIER_BANDS, type TierBand } from "../../lib/engine/stats";

/**
 * Meta trends: every daily refresh commits a snapshot, so git history is a
 * time series. Walks the snapshot's commit history and emits per-hero
 * win/pick/ban trajectories to public/data/trends.json.
 *
 * Needs full git history — the refresh workflow checks out with
 * fetch-depth: 0 before running this.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const SNAPSHOT_REPO_PATH = "src/web/public/data/snapshot.json";
const OUT_PATH = resolve(SCRIPT_DIR, "../../public/data/trends.json");

/** Bands worth the payload; one snapshot/day for a year stays ~small. */
const BANDS: TierBand[] = ["all", "diamond+"];
const MAX_DAYS = 120;

interface HeroDay {
  wr: number | null;
  pick: number | null;
  ban: number | null;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function bandStats(snapshot: Snapshot, band: TierBand): Map<string, HeroDay> {
  const perHero = new Map<
    string,
    { matches: number; wrMatches: number; wrWins: number; bans: number }
  >();
  for (const code of TIER_BANDS[band]) {
    const bucket = snapshot.stats[code];
    if (bucket == null) continue;
    for (const [slug, s] of Object.entries(bucket)) {
      const agg = perHero.get(slug) ?? {
        matches: 0,
        wrMatches: 0,
        wrWins: 0,
        bans: 0,
      };
      agg.matches += s.matches;
      agg.wrMatches += s.wrMatches;
      agg.wrWins += s.wrWins;
      agg.bans += s.bans ?? 0;
      perHero.set(slug, agg);
    }
  }
  const totalSlots = [...perHero.values()].reduce((n, a) => n + a.matches, 0);
  const games = totalSlots / 12;
  const out = new Map<string, HeroDay>();
  for (const [slug, agg] of perHero) {
    out.set(slug, {
      wr: agg.wrMatches > 0 ? agg.wrWins / agg.wrMatches : null,
      pick: totalSlots > 0 ? agg.matches / totalSlots : null,
      ban: games > 0 ? agg.bans / games : null,
    });
  }
  return out;
}

function main() {
  // Oldest first; one entry per calendar day (last commit of the day wins).
  const log = git(
    "log",
    "--follow",
    "--format=%H %cs",
    "--",
    SNAPSHOT_REPO_PATH,
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split(" ");
      return { sha, date };
    })
    .reverse();
  const byDay = new Map<string, string>();
  for (const { sha, date } of log) byDay.set(date, sha);
  const days = [...byDay.entries()].slice(-MAX_DAYS);

  const dates: string[] = [];
  const perBand = new Map<TierBand, Map<string, (HeroDay | null)[]>>(
    BANDS.map((b) => [b, new Map()]),
  );
  const heroMeta = new Map<string, { name: string; role: string }>();

  for (const [date, sha] of days) {
    let snapshot: Snapshot;
    try {
      const raw = git("show", `${sha}:${SNAPSHOT_REPO_PATH}`);
      const parsed = snapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue; // pre-schema-change snapshots
      snapshot = parsed.data;
    } catch {
      continue;
    }
    const dayIdx = dates.length;
    dates.push(date);
    for (const h of snapshot.heroes) {
      heroMeta.set(h.id, { name: h.name, role: h.role });
    }
    for (const band of BANDS) {
      const stats = bandStats(snapshot, band);
      const series = perBand.get(band)!;
      for (const slug of heroMeta.keys()) {
        let arr = series.get(slug);
        if (arr == null) {
          arr = [];
          series.set(slug, arr);
        }
        while (arr.length < dayIdx) arr.push(null); // hero absent earlier
        arr.push(stats.get(slug) ?? null);
      }
    }
  }
  // pad heroes that vanished mid-window
  for (const band of BANDS) {
    for (const arr of perBand.get(band)!.values()) {
      while (arr.length < dates.length) arr.push(null);
    }
  }

  const round = (x: number | null | undefined) =>
    x == null ? null : Math.round(x * 10000) / 10000;
  const bands: Record<string, object> = {};
  for (const band of BANDS) {
    const heroes: Record<string, object> = {};
    for (const [slug, arr] of perBand.get(band)!) {
      const meta = heroMeta.get(slug);
      if (meta == null) continue;
      heroes[slug] = {
        name: meta.name,
        role: meta.role,
        wr: arr.map((d) => round(d?.wr)),
        pick: arr.map((d) => round(d?.pick)),
        ban: arr.map((d) => round(d?.ban)),
      };
    }
    bands[band] = heroes;
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      dates,
      bands,
    }) + "\n",
  );
  console.log(
    `Wrote trends.json — ${dates.length} snapshot days, ${heroMeta.size} heroes, bands: ${BANDS.join(", ")}.`,
  );
}

main();
