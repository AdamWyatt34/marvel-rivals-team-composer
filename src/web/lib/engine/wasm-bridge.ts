import type { ComposeInput, ComposeResult } from "./compose";
import { TS_ENGINE, type EngineOps } from "./ops";
import { calibratedProb } from "./scorer";
import { SCORING_PARAMS, type ScoringTables } from "./stats";
import { NoFeasibleTeamError, type Role, type TeamScore } from "./types";

/**
 * Flattens ScoringTables into the two typed arrays crates/rivals-engine parses
 * (`tables.rs`). The layout is versioned: Rust rejects a tag it does not know,
 * and the caller then keeps the TypeScript engine for that tables object.
 *
 * Hero index = insertion order of `tables.heroes`, which is the pool iteration
 * order compose.ts walks; the Rust beam search reproduces it from the index.
 */

export const LAYOUT_VERSION = 1;

/** Parameters cross in this order; Rust never carries its own copy of them. */
export const PARAM_ORDER = [
  "K_HERO",
  "K_MATCHUP",
  "K_MAP",
  "K_TEAMUP",
  "K_SHAPE",
  "K_COVERAGE",
  "K_PAIR",
  "K_COUNTER",
  "META_THREAT_COUNT",
] as const satisfies readonly (keyof typeof SCORING_PARAMS)[];

const ROLE_CODE: Record<Role, number> = {
  Vanguard: 0,
  Duelist: 1,
  Strategist: 2,
};
const SHAPE_DIM = 7;

export interface FlatTables {
  u32: Uint32Array;
  f64: Float64Array;
  heroIds: string[];
  heroIndex: Map<string, number>;
  mapIndex: Map<string, number>;
}

export function flattenTables(tables: ScoringTables): FlatTables {
  const heroIds = [...tables.heroes.keys()];
  const heroIndex = new Map(heroIds.map((id, i) => [id, i]));
  const n = heroIds.length;

  const mapIndex = new Map<string, number>();
  for (const key of tables.mapDelta.keys()) {
    const mapId = key.slice(key.indexOf("|") + 1);
    if (!mapIndex.has(mapId)) mapIndex.set(mapId, mapIndex.size);
  }
  const m = mapIndex.size;

  const slugRank = new Uint32Array(n);
  [...heroIds].sort().forEach((id, rank) => {
    slugRank[heroIndex.get(id)!] = rank;
  });

  // A slug the roster does not know cannot be represented by index; the
  // engine falls back to TypeScript for these tables rather than miscompute
  // (an unmapped id would otherwise coerce to hero 0 in the typed array).
  const indexOf = (id: string, where: string): number => {
    const i = heroIndex.get(id);
    if (i == null) throw new Error(`Unknown hero id in ${where}: ${id}`);
    return i;
  };
  const metaThreats = tables.metaThreats.map((id) =>
    indexOf(id, "metaThreats"),
  );

  const anchors: number[] = [];
  const variantStart = [0];
  const memberStart = [0];
  const members: number[] = [];
  const variantBonus: number[] = [];
  for (const teamUp of tables.teamUps) {
    anchors.push(indexOf(teamUp.anchor, `team-up ${teamUp.name}`));
    for (const variant of teamUp.variants) {
      for (const id of variant.members)
        members.push(indexOf(id, `team-up ${teamUp.name}`));
      memberStart.push(members.length);
      variantBonus.push(variant.bonus);
    }
    variantStart.push(variantBonus.length);
  }

  const u32 = Uint32Array.from([
    LAYOUT_VERSION,
    n,
    m,
    tables.teamUps.length,
    variantBonus.length,
    members.length,
    metaThreats.length,
    tables.fieldMatchup.size > 0 ? 1 : 0,
    tables.pairSynergy.size > 0 ? 1 : 0,
    ...heroIds.map((id) => ROLE_CODE[tables.heroes.get(id)!.role]),
    ...slugRank,
    ...metaThreats,
    ...anchors,
    ...variantStart,
    ...memberStart,
    ...members,
  ]);

  const perHero = (table: Map<string, number>) =>
    heroIds.map((id) => table.get(id) ?? 0);
  const pairMatrix = (
    table: Map<string, number>,
    separator: string,
    symmetric: boolean,
  ) => {
    const out = new Float64Array(n * n);
    for (const [key, value] of table) {
      const cut = key.indexOf(separator);
      const a = heroIndex.get(key.slice(0, cut));
      const b = heroIndex.get(key.slice(cut + 1));
      if (a == null || b == null) continue;
      out[a * n + b] = value;
      if (symmetric) out[b * n + a] = value;
    }
    return out;
  };
  const mapMatrix = new Float64Array(n * m);
  for (const [key, value] of tables.mapDelta) {
    const cut = key.indexOf("|");
    const h = heroIndex.get(key.slice(0, cut));
    if (h == null) continue;
    mapMatrix[h * m + mapIndex.get(key.slice(cut + 1))!] = value;
  }
  const shape = new Float64Array(SHAPE_DIM ** 3).fill(NaN);
  for (const [key, value] of tables.shapeDelta) {
    const [v, d, s] = key.split("-").map(Number);
    if ([v, d, s].some((c) => !Number.isInteger(c) || c < 0 || c >= SHAPE_DIM))
      continue;
    shape[v * SHAPE_DIM * SHAPE_DIM + d * SHAPE_DIM + s] = value;
  }

  const f64 = Float64Array.from([
    ...PARAM_ORDER.map((name) => SCORING_PARAMS[name]),
    tables.pBar,
    tables.zBar,
    tables.temperature,
    ...perHero(tables.strength),
    ...perHero(tables.personalDelta),
    ...perHero(tables.banRate),
    ...perHero(tables.strengthSamples),
    ...pairMatrix(tables.matchup, "|", false),
    ...pairMatrix(tables.counterEdge, "|", false),
    ...pairMatrix(tables.pairSynergy, "+", true),
    ...mapMatrix,
    ...perHero(tables.fieldShare),
    ...perHero(tables.fieldMatchup),
    ...shape,
    ...variantBonus,
  ]);

  return { u32, f64, heroIds, heroIndex, mapIndex };
}

/**
 * The shape of the wasm-pack glue this bridge drives (`src/web/wasm/`), typed
 * structurally so lib/engine never imports the artifact: the engine compiles
 * and tests without it, and tests can hand in a stub.
 */
export interface WasmTablesHandle {
  score_z(
    ours: Uint32Array,
    enemy: Uint32Array,
    banned: Uint32Array,
    mapIndex: number,
    mapGiven: boolean,
  ): number;
  compose(
    locked: Uint32Array,
    enemy: Uint32Array,
    banned: Uint32Array,
    pool: Uint32Array,
    hasPool: boolean,
    mapIndex: number,
    mapGiven: boolean,
    minStrategists: number,
    minVanguards: number,
    minDuelists: number,
    teamSize: number,
    beamWidth: number,
  ): Float64Array;
  free(): void;
}

export interface WasmEngineModule {
  WasmTables: new (u32: Uint32Array, f64: Float64Array) => WasmTablesHandle;
}

interface Loaded extends FlatTables {
  handle: WasmTablesHandle;
}

const DEFAULT_BEAM_WIDTH = 32;

/**
 * Wraps a loaded module as an EngineOps. Tables are flattened once per object
 * (WeakMap, so a personal overlay gets its own handle and the Rust side is
 * freed with it through wasm-bindgen's FinalizationRegistry). Any failure the
 * TypeScript engine would not raise — a bad layout, a trap from a Rust panic —
 * poisons the engine for the rest of this JS context: the current call and
 * every later one run on the TypeScript engine, `name` reports "ts", and
 * `onFallback` hears the reason once (the loader logs it in dev).
 */
export function createWasmEngine(
  mod: WasmEngineModule,
  onFallback?: (reason: string) => void,
): EngineOps {
  const loaded = new WeakMap<ScoringTables, Loaded>();
  let poisoned: string | null = null;

  function poison(reason: unknown): void {
    poisoned = reason instanceof Error ? reason.message : String(reason);
    onFallback?.(poisoned);
  }

  function tablesFor(tables: ScoringTables): Loaded | null {
    if (poisoned != null) return null;
    const hit = loaded.get(tables);
    if (hit != null) return hit;
    try {
      const flat = flattenTables(tables);
      const entry = { ...flat, handle: new mod.WasmTables(flat.u32, flat.f64) };
      loaded.set(tables, entry);
      return entry;
    } catch (error) {
      poison(error);
      return null;
    }
  }

  const indices = (t: Loaded, ids: readonly string[]) =>
    Uint32Array.from(
      ids.map((id) => t.heroIndex.get(id)).filter((i): i is number => i != null),
    );

  function mapArgs(t: Loaded, mapId: string | null | undefined): [number, boolean] {
    return mapId != null ? [t.mapIndex.get(mapId) ?? -1, true] : [-1, false];
  }

  const compose = (tables: ScoringTables, input: ComposeInput): ComposeResult => {
    for (const id of input.myLockedIds) {
      if (!tables.heroes.has(id)) throw new Error(`Unknown locked hero id: ${id}`);
    }
    const t = tablesFor(tables);
    if (t == null) return TS_ENGINE.compose(tables, input);
    const { rules } = input;
    const [mapIndex, mapGiven] = mapArgs(t, input.mapId);
    let out: Float64Array;
    try {
      out = t.handle.compose(
        indices(t, input.myLockedIds),
        indices(t, input.enemyIds),
        indices(t, input.bannedIds),
        indices(t, input.poolIds ?? []),
        input.poolIds != null,
        mapIndex,
        mapGiven,
        rules.minStrategists,
        rules.minVanguards,
        rules.minDuelists,
        rules.teamSize,
        input.beamWidth ?? DEFAULT_BEAM_WIDTH,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "NoFeasibleTeamError") throw new NoFeasibleTeamError();
      if (message.startsWith("Unknown locked hero id")) throw new Error(message);
      poison(error);
      return TS_ENGINE.compose(tables, input);
    }
    const z = out[0];
    return {
      team: Array.from(out.subarray(1), (i) => tables.heroes.get(t.heroIds[i])!),
      z,
      prob: calibratedProb(tables, z),
    };
  };

  const scoreTeam = (
    tables: ScoringTables,
    ourIds: readonly string[],
    enemyIds: readonly string[],
    mapId?: string | null,
    bannedIds: readonly string[] = [],
  ): TeamScore => {
    // An unknown enemy still counts toward |E| in the TypeScript scorer, so
    // dropping it would not be exact; the app never sends one (both sides come
    // from compose results), so that case simply keeps the TypeScript path.
    const t = tablesFor(tables);
    if (
      t == null ||
      !ourIds.every((id) => t.heroIndex.has(id)) ||
      !enemyIds.every((id) => t.heroIndex.has(id))
    ) {
      return TS_ENGINE.scoreTeam(tables, ourIds, enemyIds, mapId, bannedIds);
    }
    const [mapIndex, mapGiven] = mapArgs(t, mapId);
    let z: number;
    try {
      z = t.handle.score_z(
        indices(t, ourIds),
        indices(t, enemyIds),
        indices(t, bannedIds),
        mapIndex,
        mapGiven,
      );
    } catch (error) {
      poison(error);
      return TS_ENGINE.scoreTeam(tables, ourIds, enemyIds, mapId, bannedIds);
    }
    return { z, prob: calibratedProb(tables, z) };
  };

  return {
    get name() {
      return poisoned == null ? "wasm" : "ts";
    },
    compose,
    scoreTeam,
  };
}
