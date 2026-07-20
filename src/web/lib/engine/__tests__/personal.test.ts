import { describe, expect, it } from "vitest";
import { scoreTeam, scoreTeamDetailed } from "../scorer";
import { buildScoringTables, SCORING_PARAMS, withPersonal } from "../stats";
import { FIXTURE } from "./fixture";

const TEAM = ["thor", "hulk", "iron-man", "hela", "mantis", "luna-snow"];
const ENEMY = ["magneto", "the-punisher", "loki", "adam-warlock"];

describe("withPersonal", () => {
  const tables = buildScoringTables(FIXTURE, "diamond+");

  it("a strong personal record raises our score but not the enemy's", () => {
    const personalized = withPersonal(tables, [
      { id: "thor", games: 60, wins: 45 },
    ]);
    const base = scoreTeam(tables, TEAM, ENEMY);
    const boosted = scoreTeam(personalized, TEAM, ENEMY);
    expect(boosted.z).toBeGreaterThan(base.z);

    // thor on the ENEMY side must not get our personal boost
    const asEnemy = scoreTeam(personalized, ENEMY.slice(0, 4), TEAM);
    const asEnemyBase = scoreTeam(tables, ENEMY.slice(0, 4), TEAM);
    expect(asEnemy.z).toBeCloseTo(asEnemyBase.z, 10);
  });

  it("deltas are capped and tiny samples shrink toward the band rate", () => {
    const extreme = withPersonal(tables, [
      { id: "thor", games: 500, wins: 500 },
    ]);
    expect(extreme.personalDelta.get("thor")).toBeCloseTo(
      SCORING_PARAMS.PERSONAL_CAP,
      5,
    );
    // 2/2 games against a 30-game prior: well under the 500-game delta
    const tiny = withPersonal(tables, [{ id: "thor", games: 2, wins: 2 }]);
    expect(tiny.personalDelta.get("thor")!).toBeLessThan(
      extreme.personalDelta.get("thor")! * 0.6,
    );
  });

  it("shows up as a labeled contribution", () => {
    const personalized = withPersonal(tables, [
      { id: "thor", games: 60, wins: 45 },
    ]);
    const detailed = scoreTeamDetailed(personalized, TEAM, ENEMY);
    const personal = detailed.contributions.find((c) => c.kind === "personal");
    expect(personal).toBeDefined();
    expect(personal!.ids).toEqual(["thor"]);
    expect(personal!.deltaLogOdds).toBeGreaterThan(0);
  });

  it("ignores unknown heroes and zero-game records", () => {
    const personalized = withPersonal(tables, [
      { id: "not-a-hero", games: 10, wins: 9 },
      { id: "hulk", games: 0, wins: 0 },
    ]);
    expect(personalized.personalDelta.size).toBe(0);
  });
});
