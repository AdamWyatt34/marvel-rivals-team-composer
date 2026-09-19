import { compose, type ComposeInput, type ComposeResult } from "./compose";
import { scoreTeam } from "./scorer";
import type { ScoringTables } from "./stats";
import type { TeamScore } from "./types";

/**
 * The two hot operations a search needs. Callers take an EngineOps so the
 * WASM port can be injected where it is loaded (worker, direct path) while
 * everything else — tests, backups, explain, the Node CLIs — keeps the
 * TypeScript engine by default.
 */
export interface EngineOps {
  /** "ts" or "wasm"; a WASM engine reports "ts" once it has fallen back. */
  readonly name: "ts" | "wasm";
  compose(tables: ScoringTables, input: ComposeInput): ComposeResult;
  scoreTeam(
    tables: ScoringTables,
    ourIds: readonly string[],
    enemyIds: readonly string[],
    mapId?: string | null,
    bannedIds?: readonly string[],
  ): TeamScore;
}

export const TS_ENGINE: EngineOps = { name: "ts", compose, scoreTeam };
