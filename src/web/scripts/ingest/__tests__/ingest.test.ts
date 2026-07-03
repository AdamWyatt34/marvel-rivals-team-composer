import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNuxtPage, routeData } from "../devalue-parse";
import {
  fetchMatchups,
  isFresh,
  seasonLabel,
  type RawStats,
} from "../rivalsmeta";
import { normalize } from "../normalize";
import { validateSnapshot } from "../validate";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../__fixtures__",
);
const matchupsHtml = readFileSync(
  resolve(FIXTURES, "matchups-thor.html"),
  "utf8",
);
const rawStats = JSON.parse(
  readFileSync(resolve(FIXTURES, "stats-season16.json"), "utf8"),
) as RawStats;

// The fixtures were captured 2026-07-03; freeze "now" near that.
const NOW = new Date("2026-07-03T12:00:00Z");

describe("parseNuxtPage", () => {
  it("decodes the devalue payload and exposes route data", () => {
    const payload = parseNuxtPage(matchupsHtml);
    const matrix = routeData<Record<string, unknown>>(payload);
    expect(Object.keys(matrix).length).toBeGreaterThanOrEqual(35);
  });

  it("throws a loud error when the NUXT_DATA tag is missing", () => {
    expect(() => parseNuxtPage("<html><body>nope</body></html>")).toThrow(
      /__NUXT_DATA__/,
    );
  });
});

describe("fetchMatchups (from fixture html)", () => {
  it("extracts a hero-keyed matrix with symmetric match counts", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    // Thor (1039) vs Hela (1024): h-vs-e matches should equal e-vs-h matches,
    // and the two sides' wins should sum to (roughly) the shared match count.
    const thorVsHela = matrix["1039"]["1024"];
    const helaVsThor = matrix["1024"]["1039"];
    expect(thorVsHela.matches).toBe(helaVsThor.matches);
    expect(thorVsHela.wins + helaVsThor.wins).toBe(thorVsHela.matches);
  });
});

describe("normalize", () => {
  it("produces a snapshot that passes validation", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    const snapshot = normalize(rawStats, matrix, NOW);
    expect(() => validateSnapshot(snapshot, null)).not.toThrow();
  });

  it("maps rivalsmeta ids to slugs and drops mirror matchups", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    const snapshot = normalize(rawStats, matrix, NOW);
    expect(snapshot.matchups["thor"]).toBeDefined();
    expect(snapshot.matchups["thor"]["thor"]).toBeUndefined();
    expect(snapshot.matchups["thor"]["winter-soldier"].matches).toBeGreaterThan(
      0,
    );
    // ban counts land on Gold+ buckets only
    expect(snapshot.stats["3"]["thor"].bans).toBeGreaterThan(0);
    expect(snapshot.stats["1"]["thor"].bans).toBeUndefined();
    // per-map counts exist for a known map
    expect(snapshot.heroMaps["thor"]["1291"].matches).toBeGreaterThan(0);
  });

  it("fails loudly on an unmapped hero id", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    const doctored = structuredClone(rawStats);
    doctored.heroes[0].heroes[0].hero_id = 9999;
    expect(() => normalize(doctored, matrix, NOW)).toThrow(/9999/);
  });
});

describe("validateSnapshot", () => {
  it("rejects a snapshot whose global WR drifts", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    const snapshot = normalize(rawStats, matrix, NOW);
    for (const perHero of Object.values(snapshot.stats)) {
      for (const s of Object.values(perHero))
        s.wrWins = Math.round(s.wrMatches * 0.6);
    }
    expect(() => validateSnapshot(snapshot, null)).toThrow(/global WR/);
  });

  it("rejects a big drop in volume vs the previous snapshot within a season", async () => {
    const matrix = await fetchMatchups(matchupsHtml);
    const snapshot = normalize(rawStats, matrix, NOW);
    const previous = structuredClone(snapshot);
    for (const perHero of Object.values(previous.stats)) {
      for (const s of Object.values(perHero)) {
        s.wrMatches *= 10;
        s.wrWins *= 5;
      }
    }
    expect(() => validateSnapshot(snapshot, previous)).toThrow(
      /dropped below half/,
    );
  });
});

describe("season helpers", () => {
  it("labels whole and half seasons", () => {
    expect(seasonLabel(16)).toBe("Season 8");
    expect(seasonLabel(17)).toBe("Season 8.5");
  });

  it("computes freshness against a fixed clock", () => {
    expect(isFresh(NOW.getTime() / 1000 - 86400, NOW)).toBe(true);
    expect(isFresh(NOW.getTime() / 1000 - 30 * 86400, NOW)).toBe(false);
  });
});
