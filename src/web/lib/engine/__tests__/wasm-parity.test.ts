import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { calibrationSchema } from "../../data/calibration-schema";
import { pairsTableSchema } from "../../data/pairs-schema";
import { snapshotSchema } from "../../data/schema";
import { suggestBans } from "../bans";
import { TS_ENGINE, type EngineOps } from "../ops";
import {
  buildScoringTables,
  TIER_BANDS,
  withPersonal,
  type ScoringTables,
  type TierBand,
} from "../stats";
import { DEFAULT_RULES, NoFeasibleTeamError } from "../types";
import { createWasmEngine, flattenTables } from "../wasm-bridge";
import * as glue from "../../../wasm/rivals_engine";

/**
 * The oracle for crates/rivals-engine: the committed .wasm against the
 * TypeScript engine over the real snapshot, with pairs and calibration loaded
 * the way local-api loads them (without pairs the pair/counter terms are all
 * zero and prove nothing). z is asserted bit-identical, never approximately —
 * a mismatch is a bug in the crate, and the fix is followed by wasm:build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../../../public/data");
const read = (file: string) =>
  JSON.parse(readFileSync(resolve(dataDir, file), "utf8"));

glue.initSync({
  module: readFileSync(resolve(here, "../../../wasm/rivals_engine_bg.wasm")),
});

const snapshot = snapshotSchema.parse(read("snapshot.json"));
const pairs = pairsTableSchema.parse(read("pairs.json"));
const calibration = calibrationSchema.parse(read("calibration.json"));
const bands = Object.keys(TIER_BANDS) as TierBand[];
const tablesByBand = new Map(
  bands.map((band) => [
    band,
    buildScoringTables(snapshot, band, pairs, calibration.temperature),
  ]),
);
const all = tablesByBand.get("all")!;

// Every case must prove the WASM path actually ran: a poisoned engine would
// otherwise answer from TypeScript and the comparison would pass vacuously.
const counts = { construct: 0, compose: 0, score: 0 };
class CountingTables extends glue.WasmTables {
  constructor(u32: Uint32Array, f64: Float64Array) {
    super(u32, f64);
    counts.construct++;
  }
  compose(...args: Parameters<glue.WasmTables["compose"]>) {
    counts.compose++;
    return super.compose(...args);
  }
  score_z(...args: Parameters<glue.WasmTables["score_z"]>) {
    counts.score++;
    return super.score_z(...args);
  }
}
const wasm: EngineOps = createWasmEngine(
  { WasmTables: CountingTables },
  (reason) => {
    throw new Error(`WASM fell back to TypeScript: ${reason}`);
  },
);

const smoke = {
  myLockedIds: ["thor", "winter-soldier"],
  enemyIds: ["hela", "luna-snow"],
  bannedIds: ["phoenix"],
  mapId: "1291",
  rules: DEFAULT_RULES,
};

type Input = Parameters<EngineOps["compose"]>[1];

function expectComposeParity(tables: ScoringTables, input: Input) {
  const before = counts.compose;
  const ts = TS_ENGINE.compose(tables, input);
  const rs = wasm.compose(tables, input);
  expect(rs.team.map((h) => h.id)).toEqual(ts.team.map((h) => h.id));
  expect(rs.team).toEqual(ts.team);
  expect(rs.z).toBe(ts.z);
  expect(rs.prob).toBe(ts.prob);
  expect(counts.compose).toBe(before + 1);
  expect(wasm.name).toBe("wasm");
  return ts;
}

function expectScoreParity(
  tables: ScoringTables,
  ours: readonly string[],
  enemy: readonly string[],
  mapId?: string | null,
  bans: readonly string[] = [],
) {
  const before = counts.score;
  const ts = TS_ENGINE.scoreTeam(tables, ours, enemy, mapId, bans);
  const rs = wasm.scoreTeam(tables, ours, enemy, mapId, bans);
  expect(rs.z).toBe(ts.z);
  expect(rs.prob).toBe(ts.prob);
  expect(counts.score).toBe(before + 1);
}

function expectBansParity(tables: ScoringTables, input: Input) {
  const before = counts.compose;
  const ts = suggestBans(
    tables,
    input.myLockedIds,
    input.enemyIds,
    input.bannedIds,
    DEFAULT_RULES,
    3,
    input.mapId,
    TS_ENGINE,
  );
  const rs = suggestBans(
    tables,
    input.myLockedIds,
    input.enemyIds,
    input.bannedIds,
    DEFAULT_RULES,
    3,
    input.mapId,
    wasm,
  );
  expect(rs).toEqual(ts);
  expect(counts.compose).toBeGreaterThan(before);
  expect(wasm.name).toBe("wasm");
}

describe("WASM engine parity with the TypeScript engine", () => {
  beforeEach(() => {
    expect(wasm.name).toBe("wasm");
  });

  it("smoke: thor + winter-soldier vs hela + luna-snow, ban phoenix, map 1291, band all", () => {
    const result = expectComposeParity(all, smoke);
    const ids = result.team.map((h) => h.id);
    expectScoreParity(all, ids, smoke.enemyIds, smoke.mapId, smoke.bannedIds);
    expect(counts.construct).toBe(1);
  });

  it("smoke inputs on every band", () => {
    for (const band of bands)
      expectComposeParity(tablesByBand.get(band)!, smoke);
  });

  it("other maps and no map", () => {
    const maps = [...flattenTables(all).mapIndex.keys()]
      .filter((m) => m !== "1291")
      .slice(0, 3);
    expect(maps).toHaveLength(3);
    for (const mapId of maps) expectComposeParity(all, { ...smoke, mapId });
    expectComposeParity(all, { ...smoke, mapId: null });
    expectComposeParity(all, { ...smoke, mapId: "no-such-map" });
  });

  it("a personal overlay gets its own tables and still matches", () => {
    const personal = withPersonal(all, [
      { id: "thor", games: 60, wins: 45 },
      { id: "hela", games: 40, wins: 10 },
      { id: "loki", games: 25, wins: 5 },
    ]);
    const constructs = counts.construct;
    expectComposeParity(personal, smoke);
    expect(counts.construct).toBe(constructs + 1);
    expectComposeParity(personal, smoke);
    expect(counts.construct).toBe(constructs + 1);
  });

  it("a pool restriction", () => {
    const poolIds = [
      ...smoke.myLockedIds,
      ...[...all.heroes.keys()].slice(0, 18),
    ];
    expectComposeParity(all, { ...smoke, poolIds });
  });

  it("no locks, no enemy, no bans, no map (field-only matchup path)", () => {
    expectComposeParity(all, {
      myLockedIds: [],
      enemyIds: [],
      bannedIds: [],
      mapId: null,
      rules: DEFAULT_RULES,
    });
  });

  it("an infeasible lock set throws NoFeasibleTeamError on both engines", () => {
    const duelists = [...all.heroes.values()]
      .filter((h) => h.role === "Duelist")
      .slice(0, 5)
      .map((h) => h.id);
    const input = { ...smoke, myLockedIds: duelists };
    expect(() => TS_ENGINE.compose(all, input)).toThrow(NoFeasibleTeamError);
    expect(() => wasm.compose(all, input)).toThrow(NoFeasibleTeamError);
  });

  it("an unknown lock throws the same error on both engines", () => {
    const input = { ...smoke, myLockedIds: ["not-a-hero"] };
    expect(() => TS_ENGINE.compose(all, input)).toThrow(
      /Unknown locked hero id: not-a-hero/,
    );
    expect(() => wasm.compose(all, input)).toThrow(
      /Unknown locked hero id: not-a-hero/,
    );
  });

  it("scoreTeam on hand-picked teams", () => {
    const heroes = [...all.heroes.keys()];
    const six = heroes.slice(0, 6);
    const enemySix = heroes.slice(6, 12);
    expectScoreParity(all, six, enemySix, "1291");
    expectScoreParity(all, heroes.slice(12, 15), heroes.slice(20, 22), null);
    expectScoreParity(
      all,
      ["hela", ...heroes.slice(30, 35)],
      ["hela", "luna-snow"],
      "1291",
      ["phoenix"],
    );
    expectScoreParity(all, six, ["hela", "hela"], "1291");
    expectScoreParity(all, [], [], null);
    expectScoreParity(all, [], ["hela", "luna-snow"], "1291");
    expectScoreParity(all, [], ["hela", "luna-snow"], null);
    expectScoreParity(all, ["thor"], [], null);
    expectScoreParity(all, six, enemySix, "1291", [
      ...heroes.slice(40, 56),
      "ghost",
    ]);
  });

  it("every team-up's largest variant scores identically", () => {
    for (const teamUp of all.teamUps) {
      const members = [
        ...new Set([...teamUp.variants[0].members, teamUp.anchor]),
      ];
      expectScoreParity(all, members, [], null);
      expectScoreParity(
        all,
        members,
        smoke.enemyIds,
        smoke.mapId,
        smoke.bannedIds,
      );
    }
  });

  it("suggestBans: smoke case", () => {
    expectBansParity(all, smoke);
  });

  it("suggestBans: personal overlay", () => {
    const personal = withPersonal(all, [
      { id: "thor", games: 60, wins: 45 },
      { id: "hela", games: 40, wins: 10 },
    ]);
    expectBansParity(personal, smoke);
  });

  it("suggestBans: no locks and no enemy", () => {
    expectBansParity(all, {
      myLockedIds: [],
      enemyIds: [],
      bannedIds: [],
      mapId: null,
      rules: DEFAULT_RULES,
    });
  });

  it("a module whose tables cannot load falls back to TypeScript for the session", () => {
    const reasons: string[] = [];
    const broken = createWasmEngine(
      {
        WasmTables: class {
          constructor() {
            throw new Error("boom");
          }
        } as unknown as typeof glue.WasmTables,
      },
      (reason) => reasons.push(reason),
    );
    expect(broken.compose(all, smoke)).toEqual(TS_ENGINE.compose(all, smoke));
    expect(broken.name).toBe("ts");
    expect(reasons).toEqual(["boom"]);
  });
});
