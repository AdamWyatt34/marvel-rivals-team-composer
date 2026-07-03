import { describe, expect, it } from "vitest";
import { buildBackups } from "../backups";
import { suggestBans, threatScore } from "../bans";
import { compose } from "../compose";
import { explainTeam } from "../explain";
import { scoreTeam, scoreTeamDetailed } from "../scorer";
import {
  buildScoringTables,
  capStrength,
  logit,
  shrunk,
  SCORING_PARAMS,
} from "../stats";
import { threatsAgainst } from "../threats";
import { DEFAULT_RULES, NoFeasibleTeamError } from "../types";
import { FIXTURE } from "./fixture";

const tables = buildScoringTables(FIXTURE, "diamond+");

describe("stats / shrinkage", () => {
  it("band global mean is exactly 0.5 in the fixture", () => {
    expect(tables.pBar).toBeCloseTo(0.5, 10);
    expect(tables.zBar).toBeCloseTo(0, 10);
  });

  it("hero strength matches the hand-computed empirical-Bayes value", () => {
    // hela: shrunk(2750, 5000, 0.5, 400) = 2950/5400, then soft-capped
    const expected = capStrength(logit(2950 / 5400));
    expect(tables.strength.get("hela")).toBeCloseTo(expected, 10);
    // an average hero shrinks to exactly the mean -> strength 0
    expect(tables.strength.get("thor")).toBeCloseTo(0, 10);
  });

  it("a hero with no stats contributes zero strength", () => {
    expect(tables.strength.get("nobody")).toBeUndefined();
  });

  it("soft cap compresses outlier win rates more than modest ones", () => {
    // a 58%+ specialist hero must land near the cap, not at its raw log-odds
    const raw = logit(0.587);
    expect(capStrength(raw)).toBeLessThan(SCORING_PARAMS.HERO_STRENGTH_CAP);
    expect(capStrength(raw)).toBeGreaterThan(
      0.9 * SCORING_PARAMS.HERO_STRENGTH_CAP,
    );
    // ordering is preserved
    expect(capStrength(logit(0.53))).toBeLessThan(capStrength(raw));
    // small strengths pass through nearly untouched
    expect(capStrength(0.02)).toBeCloseTo(0.02, 3);
  });

  it("team-up bonuses are clamped to [TEAMUP_MIN, TEAMUP_MAX]", () => {
    for (const teamUp of tables.teamUps) {
      for (const v of teamUp.variants) {
        expect(v.bonus).toBeGreaterThanOrEqual(SCORING_PARAMS.TEAMUP_MIN);
        expect(v.bonus).toBeLessThanOrEqual(SCORING_PARAMS.TEAMUP_MAX);
      }
    }
  });

  it("matchup deltas shrink toward the hero's own baseline", () => {
    // hela's baseline: 2950/5400; matchup 600/1000 shrunk with M=250 toward it
    const base = 2950 / 5400;
    const rate = shrunk(600, 1000, base, SCORING_PARAMS.M_MATCHUP);
    const expected = logit(rate) - logit(base);
    expect(tables.matchup.get("hela|iron-man")).toBeCloseTo(expected, 10);
    expect(tables.matchup.get("thor|hulk")).toBeUndefined();
  });
});

describe("scorer", () => {
  const noTeamUpSquad = [
    "hulk",
    "magneto",
    "iron-man",
    "mantis",
    "luna-snow",
    "adam-warlock",
  ];

  it("scores a neutral mirror at exactly 0.5", () => {
    const { prob } = scoreTeam(tables, noTeamUpSquad, noTeamUpSquad);
    expect(prob).toBeCloseTo(0.5, 10);
  });

  it("a stronger hero raises win probability", () => {
    const withHela = [
      "hela",
      "magneto",
      "hulk",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const base = scoreTeam(tables, noTeamUpSquad, []).prob;
    expect(scoreTeam(tables, withHela, []).prob).toBeGreaterThan(base);
  });

  it("an enemy counter lowers our probability", () => {
    const ours = [
      "iron-man",
      "magneto",
      "hulk",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const vsNeutral = scoreTeam(tables, ours, ["the-punisher"]).prob;
    const vsCounter = scoreTeam(tables, ours, ["hela"]).prob;
    expect(vsCounter).toBeLessThan(vsNeutral);
  });

  it("map term only applies when a map is given", () => {
    const ours = [
      "thor",
      "hulk",
      "iron-man",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const noMap = scoreTeam(tables, ours, []).z;
    const goodMap = scoreTeam(tables, ours, [], "1291").z;
    const badMap = scoreTeam(tables, ours, [], "1310").z;
    expect(goodMap).toBeGreaterThan(noMap);
    expect(badMap).toBeLessThan(noMap);
  });

  it("team-up bonus activates only when members are together", () => {
    const together = [
      "hela",
      "thor",
      "hulk",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const apart = [
      "hela",
      "magneto",
      "hulk",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const zTogether = scoreTeam(tables, together, []).z;
    const zApart = scoreTeam(tables, apart, []).z;
    // thor is strength-neutral, so any difference beyond hela's strength is the team-up
    expect(zTogether).not.toBeCloseTo(zApart, 5);
    const detailed = scoreTeamDetailed(tables, together, []);
    expect(detailed.contributions.some((c) => c.kind === "teamup")).toBe(true);
  });

  it("detailed contributions sum to the same score", () => {
    const ours = [
      "hela",
      "thor",
      "iron-man",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const enemy = ["hulk", "the-punisher"];
    const fast = scoreTeam(tables, ours, enemy, "1291");
    const detailed = scoreTeamDetailed(tables, ours, enemy, "1291");
    expect(detailed.z).toBeCloseTo(fast.z, 10);
  });

  it("role-shape term prefers the winning 2-2-2 shape over 1-3-2", () => {
    // identical strength-neutral heroes, only the shape differs
    const shape222 = [
      "thor",
      "hulk",
      "iron-man",
      "the-punisher",
      "mantis",
      "luna-snow",
    ];
    const shape132 = [
      "thor",
      "iron-man",
      "the-punisher",
      "hela",
      "mantis",
      "luna-snow",
    ];
    const d222 = scoreTeamDetailed(tables, shape222, []);
    const d132 = scoreTeamDetailed(tables, shape132, []);
    const shapeOf = (d: typeof d222) =>
      d.contributions.find((c) => c.kind === "shape")?.deltaLogOdds ?? 0;
    expect(shapeOf(d222)).toBeGreaterThan(0); // 53% shape
    expect(shapeOf(d132)).toBeLessThan(0); // 47.5% shape
  });

  it("shape term only applies to complete teams", () => {
    const partial = scoreTeamDetailed(tables, ["thor", "hulk", "mantis"], []);
    expect(partial.contributions.some((c) => c.kind === "shape")).toBe(false);
  });

  it("coverage term penalizes a team with no answer to a threat", () => {
    // iron-man is hela's only known (bad) matchup in the fixture; a team of
    // six iron-man-like heroes... instead: enemy hela vs a team whose only
    // known edge into her is negative (iron-man) and the rest unknown counts
    // as neutral -> no gap. So force the gap: all six ARE iron-man-adjacent
    // isn't possible with this fixture, so test the inverse invariants.
    const withNeutral = [
      "thor",
      "hulk",
      "magneto",
      "mantis",
      "luna-snow",
      "adam-warlock",
    ];
    const d = scoreTeamDetailed(tables, withNeutral, ["hela"]);
    // unknown matchups are neutral -> no coverage gap fires
    expect(d.contributions.some((c) => c.kind === "coverage")).toBe(false);
  });

  it("coverage gap fires when every known edge into a threat is negative", () => {
    // single-hero team: iron-man's only known matchup vs hela is negative
    const d = scoreTeamDetailed(tables, ["iron-man"], ["hela"]);
    const gap = d.contributions.find((c) => c.kind === "coverage");
    expect(gap).toBeDefined();
    expect(gap!.deltaLogOdds).toBeLessThan(0);
    expect(gap!.ids).toContain("hela");
  });
});

describe("compose", () => {
  it("respects locks and always satisfies role minimums", () => {
    const result = compose(tables, {
      myLockedIds: ["thor", "iron-man"],
      enemyIds: [],
      bannedIds: [],
      rules: DEFAULT_RULES,
    });
    const ids = result.team.map((h) => h.id);
    expect(ids).toContain("thor");
    expect(ids).toContain("iron-man");
    expect(ids).toHaveLength(6);
    const roles = result.team.map((h) => h.role);
    expect(
      roles.filter((r) => r === "Strategist").length,
    ).toBeGreaterThanOrEqual(2);
    expect(roles.filter((r) => r === "Vanguard").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(roles.filter((r) => r === "Duelist").length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it("never picks banned heroes", () => {
    const result = compose(tables, {
      myLockedIds: ["thor"],
      enemyIds: [],
      bannedIds: ["hela", "loki"],
      rules: DEFAULT_RULES,
    });
    const ids = result.team.map((h) => h.id);
    expect(ids).not.toContain("hela");
    expect(ids).not.toContain("loki");
  });

  it("prefers the strong hero over the weak one, all else equal", () => {
    const result = compose(tables, {
      myLockedIds: [],
      enemyIds: [],
      bannedIds: [],
      rules: DEFAULT_RULES,
    });
    const ids = result.team.map((h) => h.id);
    expect(ids).toContain("hela");
    expect(ids).not.toContain("the-punisher");
  });

  it("throws NoFeasibleTeamError when constraints cannot be met", () => {
    expect(() =>
      compose(tables, {
        myLockedIds: [],
        enemyIds: [],
        // ban 3 of 4 strategists -> only 1 left but 2 required
        bannedIds: ["loki", "mantis", "luna-snow"],
        rules: DEFAULT_RULES,
      }),
    ).toThrow(NoFeasibleTeamError);
  });

  it("is deterministic", () => {
    const run = () =>
      compose(tables, {
        myLockedIds: ["thor"],
        enemyIds: ["hela"],
        bannedIds: [],
        mapId: "1291",
        rules: DEFAULT_RULES,
      }).team.map((h) => h.id);
    expect(run()).toEqual(run());
  });
});

describe("backups", () => {
  it("suggests same-role swaps within tolerance, excluding banned and current picks", () => {
    const team = compose(tables, {
      myLockedIds: ["thor"],
      enemyIds: [],
      bannedIds: ["the-punisher"],
      rules: DEFAULT_RULES,
    }).team;
    const backups = buildBackups(
      tables,
      team,
      [],
      ["the-punisher"],
      DEFAULT_RULES,
    );
    const all = Object.values(backups).flat();
    expect(all).not.toContain("the-punisher");
    for (const id of all) expect(team.map((h) => h.id)).not.toContain(id);
    for (const [role, ids] of Object.entries(backups)) {
      for (const id of ids) expect(tables.heroes.get(id)?.role).toBe(role);
    }
  });
});

describe("bans", () => {
  it("ranks the strong, countering, often-banned hero as the top threat", () => {
    const ourIds = ["iron-man", "thor"];
    const helaThreat = threatScore(tables, "hela", ourIds);
    const punisherThreat = threatScore(tables, "the-punisher", ourIds);
    expect(helaThreat).toBeGreaterThan(punisherThreat);
  });

  it("suggests at most k bans and never our own locks", () => {
    const bans = suggestBans(tables, ["iron-man"], [], [], DEFAULT_RULES, 3);
    expect(bans.length).toBeLessThanOrEqual(3);
    expect(bans).not.toContain("iron-man");
    expect(new Set(bans).size).toBe(bans.length);
  });
});

describe("threats", () => {
  it("flags iron-man as countered by hela", () => {
    const threats = threatsAgainst(tables, ["hela"]);
    const ironMan = threats.get("iron-man");
    expect(ironMan).toBeDefined();
    expect(ironMan!.threat).toBeGreaterThan(1);
    expect(ironMan!.by).toBe("hela");
    expect(threats.get("thor")!.threat).toBe(1);
  });
});

describe("explain", () => {
  it("produces human-readable lines from contributions", () => {
    const { winProbability, lines } = explainTeam(
      tables,
      FIXTURE,
      ["hela", "thor", "hulk", "mantis", "luna-snow", "adam-warlock"],
      ["iron-man"],
      "1291",
    );
    expect(winProbability).toBeGreaterThan(0.5);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join(" ")).toContain("Hela");
  });
});
