import type { ScoringTables } from "../lib/engine";
import type { SnapshotMap } from "../lib/data/schema";
import type { ComposePayload, ComposeResponse } from "./compose-job";

export type WorkerRequest =
  | { type: "tables"; key: string; tables: ScoringTables; maps: SnapshotMap[] }
  | { type: "compose"; id: number; key: string; payload: ComposePayload }
  | { type: "bans"; id: number; key: string; payload: ComposePayload };

export type WorkerResponse =
  | { type: "compose"; id: number; result: ComposeResponse; elapsedMs: number }
  | { type: "bans"; id: number; result: { id: string; name: string }[]; elapsedMs: number }
  | { type: "error"; id: number; name: string; message: string };
