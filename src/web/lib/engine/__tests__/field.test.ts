import { describe, expect, it } from "vitest";
import { scoreTeam, scoreTeamDetailed } from "../scorer";
import { buildScoringTables } from "../stats";
import { FIXTURE } from "./fixture";

/**
 * Field-weighted matchup term: with unknown enemy slots, each hero's expected
 * matchup edge vs the band's likely field fills in for the missing enemies.
 * Fixture matchup data: hela beats iron-man (and the mirror row inverts it);
 * everyone else has no matchup rows, so their field edge is 0.
 */

const tables = () => buildScoringTables(FIXTURE, "diamond+");

describe("field distribution (stats)", () => {
  it("normalizes availability-adjusted shares to sum 1", () => {
    const t = tables();
    const sum = [...t.fieldShare.values()].reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 10);
    // hela is banned in 60% of games, so her availability-adjusted share
    // outweighs an even-share hero's.
    expect(t.fieldShare.get("hela")!).toBeGreaterThan(
      t.fieldShare.get("thor")!,
    );
  });

  it("gives hela a positive expected edge vs the field and iron-man a negative one", () => {
    const t = tables();
    expect(t.fieldMatchup.get("hela")!).toBeGreaterThan(0);
    expect(t.fieldMatchup.get("iron-man")!).toBeLessThan(0);
    expect(t.fieldMatchup.has("thor")).toBe(false);
  });
});

describe("field term (scorer)", () => {
  it("surfaces per-hero field contributions when the enemy is unknown", () => {
    const t = tables();
    const detailed = scoreTeamDetailed(t, ["hela", "thor"], []);
    const field = detailed.contributions.filter((c) => c.kind === "field");
    expect(field).toHaveLength(1);
    expect(field[0].ids).toEqual(["hela"]);
    expect(field[0].deltaLogOdds).toBeGreaterThan(0);
  });

  it("emits no field contributions against a fully known enemy team", () => {
    const t = tables();
    const enemy = [
      "the-punisher",
      "magneto",
      "iron-man",
      "adam-warlock",
      "loki",
      "mantis",
    ];
    const detailed = scoreTeamDetailed(t, ["hela", "thor"], enemy);
    expect(detailed.contributions.some((c) => c.kind === "field")).toBe(false);
  });

  it("banning the countered hero removes the field advantage", () => {
    const t = tables();
    const withIronMan = scoreTeamDetailed(t, ["hela"], []);
    const banned = scoreTeamDetailed(t, ["hela"], [], null, ["iron-man"]);
    const edgeOf = (d: typeof banned) =>
      d.contributions.find((c) => c.kind === "field")?.deltaLogOdds ?? 0;
    expect(edgeOf(withIronMan)).toBeGreaterThan(0);
    expect(edgeOf(banned)).toBe(0);
  });

  it("locking the countered enemy moves its weight from field to matchup", () => {
    const t = tables();
    const detailed = scoreTeamDetailed(t, ["hela"], ["iron-man"]);
    expect(detailed.contributions.some((c) => c.kind === "field")).toBe(false);
    const matchup = detailed.contributions.find((c) => c.kind === "matchup");
    expect(matchup).toBeDefined();
    expect(matchup!.deltaLogOdds).toBeGreaterThan(0);
  });

  it("detailed and aggregate scorers agree with the field term active", () => {
    const t = tables();
    const our = ["hela", "thor", "hulk", "loki", "mantis", "luna-snow"];
    const agg = scoreTeam(t, our, ["iron-man"], "1291", ["the-punisher"]);
    const detailed = scoreTeamDetailed(t, our, ["iron-man"], "1291", [
      "the-punisher",
    ]);
    expect(detailed.z).toBeCloseTo(agg.z, 10);
  });

  it("prefers the hero that farms the field, all else equal", () => {
    const t = tables();
    // hela vs thor: hela also has strength/demand advantages, so compare the
    // same hero set with and without the ban that removes her field edge.
    const withField = scoreTeam(t, ["hela"], []).z;
    const withoutField = scoreTeam(t, ["hela"], [], null, ["iron-man"]).z;
    expect(withField).toBeGreaterThan(withoutField);
  });
});
