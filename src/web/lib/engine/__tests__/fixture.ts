import type { Snapshot } from "../../data/schema";

/**
 * Hand-built snapshot for engine tests. Deliberately tuned so the
 * band-global mean is exactly 0.5 (hela's +250 wins cancel punisher's -250):
 * zBar = 0 and hand-computed expectations stay simple.
 *
 * Cast: the real zod schema demands >= 35 heroes; the engine itself has no
 * such constraint and 10 keeps the fixture readable.
 */

const hero = (
  id: string,
  name: string,
  role: "Vanguard" | "Duelist" | "Strategist",
) => ({
  id,
  name,
  rivalsMetaId: 0,
  role,
});

const even = { matches: 6000, wins: 3000, wrMatches: 5000, wrWins: 2500 };

export const FIXTURE = {
  schemaVersion: 1,
  generatedAt: "2026-07-03T00:00:00.000Z",
  season: { internalId: 17, label: "Season 8.5" },
  sourceTimestamp: 1_782_000_000,
  heroes: [
    hero("thor", "Thor", "Vanguard"),
    hero("hulk", "Hulk", "Vanguard"),
    hero("magneto", "Magneto", "Vanguard"),
    hero("iron-man", "Iron Man", "Duelist"),
    hero("hela", "Hela", "Duelist"),
    hero("the-punisher", "The Punisher", "Duelist"),
    hero("loki", "Loki", "Strategist"),
    hero("mantis", "Mantis", "Strategist"),
    hero("luna-snow", "Luna Snow", "Strategist"),
    hero("adam-warlock", "Adam Warlock", "Strategist"),
  ],
  maps: [
    {
      id: "1291",
      name: "Midtown",
      area: "Empire of Eternal Night",
      mode: "Convoy",
    },
    { id: "1310", name: "Krakoa", area: "Hellfire Gala", mode: "Domination" },
  ],
  teamUps: [
    {
      id: 100001,
      name: "RAGNAROK REBIRTH",
      anchor: "hela",
      heroes: ["hela", "loki", "thor"],
      currentlyActive: true,
    },
    {
      id: 100099,
      name: "DORMANT PACT",
      anchor: "magneto",
      heroes: ["magneto", "the-punisher"],
      currentlyActive: false,
    },
    // New-style pair: the-punisher anchors two team-ups but can select only
    // one per game. Neither partner shares a squad with the-punisher in any
    // other test, and both bonuses land <= 0, so these stay inert outside
    // the select-one tests (compose must keep preferring hela over him).
    {
      id: 1014001,
      name: "MAGNETIC ARSENAL",
      anchor: "the-punisher",
      heroes: ["the-punisher", "magneto"],
      currentlyActive: true,
    },
    {
      id: 1014002,
      name: "SOUL AMMO",
      anchor: "the-punisher",
      heroes: ["the-punisher", "adam-warlock"],
      currentlyActive: true,
    },
  ],
  stats: {
    "5": {
      thor: { ...even },
      hulk: { ...even },
      magneto: { ...even },
      "iron-man": { ...even },
      hela: {
        matches: 6000,
        wins: 3300,
        wrMatches: 5000,
        wrWins: 2750,
        bans: 3000,
      },
      "the-punisher": {
        matches: 6000,
        wins: 2700,
        wrMatches: 5000,
        wrWins: 2250,
      },
      loki: { ...even },
      mantis: { ...even },
      "luna-snow": { ...even },
      "adam-warlock": { ...even },
    },
  },
  heroMaps: {
    thor: {
      "1291": { matches: 800, wins: 460 },
      "1310": { matches: 400, wins: 180 },
    },
  },
  matchups: {
    hela: { "iron-man": { matches: 1000, wins: 600 } },
    "iron-man": { hela: { matches: 1000, wins: 400 } },
  },
  teamUpStats: {
    "5": {
      "100001": {
        matches: 1000,
        wins: 580,
        variants: {
          "hela+thor": { matches: 800, wins: 460 },
          "hela+loki+thor": { matches: 200, wins: 120 },
        },
      },
      // 44% observed ~ what punisher's own weakness predicts -> bonus ~ -0.007
      "1014001": {
        matches: 1000,
        wins: 440,
        variants: { "magneto+the-punisher": { matches: 1000, wins: 440 } },
      },
      // 42% -> clearly worse (~ -0.072); must never stack with 1014001
      "1014002": {
        matches: 1000,
        wins: 420,
        variants: { "adam-warlock+the-punisher": { matches: 1000, wins: 420 } },
      },
    },
  },
  roleShapes: {
    "5": {
      "2-2-2": { matches: 8000, wins: 4240 }, // 53% — the winning shape
      "1-3-2": { matches: 4000, wins: 1900 }, // 47.5%
      "1-2-3": { matches: 1000, wins: 480 },
    },
  },
} as unknown as Snapshot;
