import { describe, expect, it } from "vitest";
import type { PairsTable } from "../../data/pairs-schema";
import {
  aggregatePairs,
  pairKey,
  type CompRow,
} from "../../../scripts/pairs/aggregate";
import { compFromDetails } from "../../../scripts/pairs/sample";
import type { MatchDetails } from "../../../scripts/pairs/rivalsmeta-matches";
import { scoreTeamDetailed } from "../scorer";
import { buildScoringTables, logit, shrunk, SCORING_PARAMS } from "../stats";
import { FIXTURE } from "./fixture";

const NOW = new Date("2026-07-03T12:00:00Z");
const EPOCH = Math.floor(NOW.getTime() / 1000);

const TEAM_A = ["thor", "hulk", "iron-man", "hela", "mantis", "luna-snow"];
const TEAM_B = [
  "magneto",
  "the-punisher",
  "loki",
  "adam-warlock",
  "hulk",
  "iron-man",
];

describe("aggregatePairs", () => {
  const row = (w: "a" | "b", t = EPOCH): CompRow => ({
    t,
    w,
    a: TEAM_A,
    b: TEAM_B,
  });

  it("counts all 15 pairs per team with the team's result", () => {
    const table = aggregatePairs([row("a")], NOW, 60);
    expect(table.totalMatches).toBe(1);
    // 15 pairs per side; hulk+iron-man appears on BOTH teams (mirror picks)
    expect(Object.keys(table.pairs).length).toBe(29);
    expect(table.pairs[pairKey("hulk", "iron-man")]).toEqual({
      matches: 2,
      wins: 1,
    });
    expect(table.pairs[pairKey("thor", "hela")]).toEqual({
      matches: 1,
      wins: 1,
    });
    expect(table.pairs[pairKey("loki", "magneto")]).toEqual({
      matches: 1,
      wins: 0,
    });
  });

  it("accumulates across matches and respects the window", () => {
    const old = row("a", EPOCH - 90 * 86400);
    const table = aggregatePairs([row("a"), row("b"), old], NOW, 60);
    expect(table.totalMatches).toBe(2);
    expect(table.pairs[pairKey("thor", "hela")]).toEqual({
      matches: 2,
      wins: 1,
    });
  });

  it("counts cross-team counter pairs from both orientations", () => {
    const table = aggregatePairs([row("a")], NOW, 60);
    // thor's team beat magneto's team; the reverse key records the loss
    expect(table.counters?.["thor|magneto"]).toEqual({ matches: 1, wins: 1 });
    expect(table.counters?.["magneto|thor"]).toEqual({ matches: 1, wins: 0 });
    // hulk and iron-man appear on both sides — mirror pairs are skipped,
    // but each still faces the other team's remaining heroes
    expect(table.counters?.["hulk|hulk"]).toBeUndefined();
    expect(table.counters?.["hulk|iron-man"]).toEqual({ matches: 2, wins: 1 });
  });
});

describe("compFromDetails", () => {
  // give fixture heroes distinct fake numeric ids for this test
  const ids = new Map(FIXTURE.heroes.map((h, i) => [h.id, 2000 + i]));
  const slugByFakeId = new Map(
    [...ids.entries()].map(([slug, id]) => [id, slug]),
  );

  const details = (aWin: boolean): MatchDetails => ({
    match_uid: "m1",
    match_players: [
      ...TEAM_A.map((slug) => ({
        camp: 0,
        cur_hero_id: ids.get(slug)!,
        is_win: aWin ? 1 : 0,
      })),
      ...TEAM_B.map((slug) => ({
        camp: 1,
        cur_hero_id: ids.get(slug)!,
        is_win: aWin ? 0 : 1,
      })),
    ],
  });

  it("extracts both teams and the winner", () => {
    const rowA = compFromDetails(details(true), slugByFakeId, EPOCH);
    expect(rowA).not.toBeNull();
    expect(rowA!.w).toBe("a");
    expect(new Set(rowA!.a)).toEqual(new Set(TEAM_A));
    expect(new Set(rowA!.b)).toEqual(new Set(TEAM_B));
    expect(compFromDetails(details(false), slugByFakeId, EPOCH)!.w).toBe("b");
  });

  it("rejects matches with unknown heroes or wrong player counts", () => {
    const d = details(true);
    d.match_players[0].cur_hero_id = 99999;
    expect(compFromDetails(d, slugByFakeId, EPOCH)).toBeNull();
    const short = details(true);
    short.match_players = short.match_players.slice(0, 11);
    expect(compFromDetails(short, slugByFakeId, EPOCH)).toBeNull();
  });
});

describe("engine pair-synergy term", () => {
  // loki+mantis: 60% observed vs both heroes exactly average (expected 50%)
  const pairs: PairsTable = {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    windowDays: 60,
    totalMatches: 5000,
    pairs: {
      "loki+mantis": { matches: 2000, wins: 1200 },
      // hela+thor is covered by the active RAGNAROK REBIRTH team-up -> excluded
      "hela+thor": { matches: 2000, wins: 1600 },
    },
  };
  const tables = buildScoringTables(FIXTURE, "diamond+", pairs);

  it("computes synergy vs the expected-from-strength baseline", () => {
    const expectedRate = 0.5; // both average in fixture, pBar = 0.5
    const observed = shrunk(1200, 2000, expectedRate, SCORING_PARAMS.M_PAIR);
    const want = Math.min(
      SCORING_PARAMS.PAIR_SYNERGY_CAP,
      logit(observed) - logit(expectedRate),
    );
    expect(tables.pairSynergy.get("loki+mantis")).toBeCloseTo(want, 10);
  });

  it("excludes pairs covered by an active team-up", () => {
    expect(tables.pairSynergy.get("hela+thor")).toBeUndefined();
  });

  it("raises the score when a synergistic pair is together", () => {
    const together = [
      "loki",
      "mantis",
      "thor",
      "hulk",
      "iron-man",
      "the-punisher",
    ];
    const apart = [
      "loki",
      "luna-snow",
      "thor",
      "hulk",
      "iron-man",
      "the-punisher",
    ];
    const zTogether = scoreTeamDetailed(tables, together, []).z;
    const zApart = scoreTeamDetailed(tables, apart, []).z;
    expect(zTogether).toBeGreaterThan(zApart);
    const pairContribution = scoreTeamDetailed(
      tables,
      together,
      [],
    ).contributions.find((c) => c.kind === "pair");
    expect(pairContribution).toBeDefined();
    expect(pairContribution!.ids).toEqual(["loki", "mantis"]);
  });

  it("is a no-op without pair data", () => {
    const bare = buildScoringTables(FIXTURE, "diamond+");
    expect(bare.pairSynergy.size).toBe(0);
  });
});
