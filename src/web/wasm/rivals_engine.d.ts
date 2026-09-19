/* tslint:disable */
/* eslint-disable */

export class WasmTables {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns `[z, hero index...]`; the bridge maps indices back to heroes and derives
     * the probability. Errors carry the TypeScript engine's names so the bridge can
     * rethrow the same types.
     */
    compose(locked: Uint32Array, enemy: Uint32Array, banned: Uint32Array, pool: Uint32Array, has_pool: boolean, map_index: number, map_given: boolean, min_strategists: number, min_vanguards: number, min_duelists: number, team_size: number, beam_width: number): Float64Array;
    constructor(u32s: Uint32Array, f64s: Float64Array);
    /**
     * `map_index` is ignored unless `map_given`; a given-but-unknown map (index -1)
     * still counts as a map for the map term, which is then exactly zero, as in TypeScript.
     */
    score_z(ours: Uint32Array, enemy: Uint32Array, banned: Uint32Array, map_index: number, map_given: boolean): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmtables_free: (a: number, b: number) => void;
    readonly wasmtables_compose: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
    readonly wasmtables_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmtables_score_z: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
