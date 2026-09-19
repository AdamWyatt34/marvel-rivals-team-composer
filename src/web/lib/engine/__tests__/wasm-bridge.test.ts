import { describe, expect, it, vi } from "vitest";
import { compose } from "../compose";
import { TS_ENGINE } from "../ops";
import { scoreTeam } from "../scorer";
import { DEFAULT_RULES, NoFeasibleTeamError } from "../types";
import {
  createWasmEngine,
  flattenTables,
  LAYOUT_VERSION,
  PARAM_ORDER,
  type WasmEngineModule,
  type WasmTablesHandle,
} from "../wasm-bridge";
import { buildScoringTables } from "../stats";
import { FIXTURE } from "./fixture";

const tables = buildScoringTables(FIXTURE, "diamond+");
const input = {
  myLockedIds: ["thor"],
  enemyIds: ["hela", "luna-snow"],
  bannedIds: ["loki"],
  mapId: "1291",
  rules: DEFAULT_RULES,
};

type Calls = { compose: unknown[][]; score: unknown[][] };

/** A stub module whose handle replays the TypeScript engine's answers. */
function stubModule(
  behaviour: Partial<WasmTablesHandle> & { construct?: () => void } = {},
): { mod: WasmEngineModule; calls: Calls } {
  const calls: Calls = { compose: [], score: [] };
  const flat = flattenTables(tables);
  class Stub implements WasmTablesHandle {
    constructor() {
      behaviour.construct?.();
    }
    score_z(...args: Parameters<WasmTablesHandle["score_z"]>) {
      calls.score.push(args);
      if (behaviour.score_z) return behaviour.score_z(...args);
      const ids = (a: Uint32Array) => Array.from(a, (i) => flat.heroIds[i]);
      const [ours, enemy, banned, mapIndex, mapGiven] = args;
      const mapId = mapGiven
        ? ([...flat.mapIndex].find(([, i]) => i === mapIndex)?.[0] ?? "unknown")
        : null;
      return scoreTeam(tables, ids(ours), ids(enemy), mapId, ids(banned)).z;
    }
    compose(...args: Parameters<WasmTablesHandle["compose"]>) {
      calls.compose.push(args);
      if (behaviour.compose) return behaviour.compose(...args);
      const ids = (a: Uint32Array) => Array.from(a, (i) => flat.heroIds[i]);
      const [locked, enemy, banned, pool, hasPool, mapIndex, mapGiven] = args;
      const mapId = mapGiven
        ? ([...flat.mapIndex].find(([, i]) => i === mapIndex)?.[0] ?? "unknown")
        : null;
      const result = compose(tables, {
        myLockedIds: ids(locked),
        enemyIds: ids(enemy),
        bannedIds: ids(banned),
        poolIds: hasPool ? ids(pool) : null,
        mapId,
        rules: DEFAULT_RULES,
      });
      return Float64Array.from([
        result.z,
        ...result.team.map((h) => flat.heroIndex.get(h.id)!),
      ]);
    }
    free() {}
  }
  return { mod: { WasmTables: Stub }, calls };
}

describe("flattenTables", () => {
  it("lays out the header, parameters and calibration in the documented order", () => {
    const flat = flattenTables(tables);
    const n = tables.heroes.size;
    expect(Array.from(flat.u32.subarray(0, 9))).toEqual([
      LAYOUT_VERSION,
      n,
      flat.mapIndex.size,
      tables.teamUps.length,
      tables.teamUps.reduce((sum, t) => sum + t.variants.length, 0),
      tables.teamUps.reduce(
        (sum, t) => sum + t.variants.reduce((s, v) => s + v.members.length, 0),
        0,
      ),
      tables.metaThreats.length,
      tables.fieldMatchup.size > 0 ? 1 : 0,
      tables.pairSynergy.size > 0 ? 1 : 0,
    ]);
    expect(Array.from(flat.f64.subarray(0, PARAM_ORDER.length + 3))).toEqual([
      0.85,
      0.8,
      0.5,
      0.4,
      0.5,
      0.6,
      0.6,
      0.3,
      8,
      tables.pBar,
      tables.zBar,
      tables.temperature,
    ]);
    expect(flat.heroIds).toEqual([...tables.heroes.keys()]);
    const [a, b] = flat.heroIds;
    expect(flat.f64[PARAM_ORDER.length + 3 + n * 4 + 0 * n + 1]).toBe(
      tables.matchup.get(`${a}|${b}`) ?? 0,
    );
  });
});

describe("createWasmEngine", () => {
  it("reproduces the TypeScript engine through the handle and reports its name", () => {
    const { mod, calls } = stubModule();
    const engine = createWasmEngine(mod);
    expect(engine.name).toBe("wasm");
    const ts = TS_ENGINE.compose(tables, input);
    const viaWasm = engine.compose(tables, input);
    expect(viaWasm.team.map((h) => h.id)).toEqual(ts.team.map((h) => h.id));
    expect(viaWasm.z).toBe(ts.z);
    expect(viaWasm.prob).toBe(ts.prob);
    expect(calls.compose).toHaveLength(1);
    const ids = ts.team.map((h) => h.id);
    expect(engine.scoreTeam(tables, ids, input.enemyIds, "1291", ["loki"])).toEqual(
      TS_ENGINE.scoreTeam(tables, ids, input.enemyIds, "1291", ["loki"]),
    );
  });

  it("maps ids to indices exactly as compose.ts filters them", () => {
    const { mod, calls } = stubModule();
    const engine = createWasmEngine(mod);
    const flat = flattenTables(tables);
    engine.compose(tables, {
      ...input,
      enemyIds: ["hela", "ghost", "hela"],
      bannedIds: ["ghost", "loki"],
      poolIds: ["hulk", "ghost", "iron-man", "mantis", "luna-snow", "magneto"],
      mapId: "no-such-map",
    });
    const [locked, enemy, banned, pool, hasPool, mapIndex, mapGiven] = calls
      .compose[0] as [
      Uint32Array,
      Uint32Array,
      Uint32Array,
      Uint32Array,
      boolean,
      number,
      boolean,
    ];
    const idx = (id: string) => flat.heroIndex.get(id)!;
    expect(Array.from(locked)).toEqual([idx("thor")]);
    expect(Array.from(enemy)).toEqual([idx("hela"), idx("hela")]);
    expect(Array.from(banned)).toEqual([idx("loki")]);
    expect(Array.from(pool)).toEqual(
      ["hulk", "iron-man", "mantis", "luna-snow", "magneto"].map(idx),
    );
    expect(hasPool).toBe(true);
    expect([mapIndex, mapGiven]).toEqual([-1, true]);

    engine.compose(tables, { ...input, mapId: null, poolIds: null });
    const [, , , pool2, hasPool2, mapIndex2, mapGiven2] = calls.compose[1] as [
      Uint32Array,
      Uint32Array,
      Uint32Array,
      Uint32Array,
      boolean,
      number,
      boolean,
    ];
    expect(pool2).toHaveLength(0);
    expect(hasPool2).toBe(false);
    expect([mapIndex2, mapGiven2]).toEqual([-1, false]);
  });

  it("rejects an unknown lock with the TypeScript text before crossing", () => {
    const { mod, calls } = stubModule();
    const engine = createWasmEngine(mod);
    expect(() =>
      engine.compose(tables, { ...input, myLockedIds: ["nobody"] }),
    ).toThrow("Unknown locked hero id: nobody");
    expect(calls.compose).toHaveLength(0);
  });

  it("keeps the TypeScript path for scoreTeam when an id is unknown", () => {
    const { mod, calls } = stubModule();
    const engine = createWasmEngine(mod);
    const viaWasm = engine.scoreTeam(tables, ["thor"], ["ghost", "hela"]);
    expect(viaWasm).toEqual(
      TS_ENGINE.scoreTeam(tables, ["thor"], ["ghost", "hela"]),
    );
    expect(calls.score).toHaveLength(0);
    expect(engine.name).toBe("wasm");
  });

  it("rethrows NoFeasibleTeamError as a real instance without falling back", () => {
    const { mod } = stubModule({
      compose: () => {
        throw new Error("NoFeasibleTeamError");
      },
    });
    const engine = createWasmEngine(mod);
    expect(() => engine.compose(tables, input)).toThrow(NoFeasibleTeamError);
    expect(engine.name).toBe("wasm");
  });

  it("falls back for the session when the tables fail to load", () => {
    const onFallback = vi.fn();
    const { mod, calls } = stubModule({
      construct: () => {
        throw new Error("layout version 7 is not 1");
      },
    });
    const engine = createWasmEngine(mod, onFallback);
    expect(engine.compose(tables, input)).toEqual(
      TS_ENGINE.compose(tables, input),
    );
    expect(engine.name).toBe("ts");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith("layout version 7 is not 1");
    expect(calls.compose).toHaveLength(0);
  });

  it("serves a trapped call from TypeScript and never touches the handle again", () => {
    let trapped = false;
    const { mod, calls } = stubModule({
      compose: () => {
        trapped = true;
        throw new Error("unreachable");
      },
    });
    const engine = createWasmEngine(mod);
    expect(engine.compose(tables, input)).toEqual(
      TS_ENGINE.compose(tables, input),
    );
    expect(trapped).toBe(true);
    expect(engine.name).toBe("ts");
    engine.scoreTeam(tables, ["thor"], ["hela"]);
    engine.compose(tables, input);
    expect(calls.compose).toHaveLength(1);
    expect(calls.score).toHaveLength(0);
  });
});

describe("flattenTables with a slug the roster does not know", () => {
  it("throws instead of coercing the id, and the engine falls back for the session", () => {
    const ghostThreat = { ...tables, metaThreats: [...tables.metaThreats, "ghost"] };
    expect(() => flattenTables(ghostThreat)).toThrow("Unknown hero id in metaThreats: ghost");
    const [teamUp, ...rest] = tables.teamUps;
    const ghostMember = {
      ...tables,
      teamUps: [{ ...teamUp, variants: [{ members: ["ghost", teamUp.anchor], bonus: 0.1 }] }, ...rest],
    };
    expect(() => flattenTables(ghostMember)).toThrow(`Unknown hero id in team-up ${teamUp.name}: ghost`);
    const onFallback = vi.fn();
    const engine = createWasmEngine(stubModule().mod, onFallback);
    expect(engine.compose(ghostThreat, input)).toEqual(TS_ENGINE.compose(ghostThreat, input));
    expect(engine.name).toBe("ts");
    expect(onFallback).toHaveBeenCalledWith("Unknown hero id in metaThreats: ghost");
  });
});
