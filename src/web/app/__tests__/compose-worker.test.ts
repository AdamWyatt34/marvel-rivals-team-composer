import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snapshotSchema } from "../../lib/data/schema";
import { buildScoringTables } from "../../lib/engine";
import { runComposeJob, runBansJob, type ComposePayload } from "../compose-job";
import { createWorkerState, handleMessage } from "../compose-worker";

const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(resolve(
  dirname(fileURLToPath(import.meta.url)), "../../public/data/snapshot.json",
), "utf8")));
const tables = buildScoringTables(snapshot, "all");
const payload: ComposePayload = {
  myLocked: ["thor", "winter-soldier"], enemyLocked: ["hela", "luna-snow"],
  bans: ["phoenix"], map: "1291", band: "all",
};

function loadedState() {
  const state = createWorkerState();
  handleMessage(state, { type: "tables", key: "all", tables: structuredClone(tables), maps: structuredClone(snapshot.maps) });
  return state;
}

describe("compose worker parity", () => {
  it("preserves the full compose response and ban list across structured clone", () => {
    const state = loadedState();
    expect(handleMessage(state, { type: "compose", id: 1, key: "all", payload })).toEqual({
      type: "compose", id: 1, result: runComposeJob(tables, snapshot.maps, payload), elapsedMs: expect.any(Number),
    });
    expect(handleMessage(state, { type: "bans", id: 2, key: "all", payload })).toEqual({
      type: "bans", id: 2, result: runBansJob(tables, payload), elapsedMs: expect.any(Number),
    });
  });

  it("serializes missing keys and infeasible teams by name", () => {
    expect(handleMessage(createWorkerState(), { type: "compose", id: 1, key: "missing", payload })).toMatchObject({
      type: "error", id: 1, name: "UnknownKeyError",
    });
    const myLocked = [...tables.heroes.values()].filter((hero) => hero.role === "Duelist").slice(0, 5).map((hero) => hero.id);
    expect(handleMessage(loadedState(), { type: "compose", id: 2, key: "all", payload: { myLocked, enemyLocked: [] } })).toMatchObject({
      type: "error", id: 2, name: "NoFeasibleTeamError",
    });
  });

  it("keeps table identity warm and clears only past 32 entries", () => {
    const state = createWorkerState();
    for (let i = 0; i < 33; i++) handleMessage(state, { type: "tables", key: String(i), tables, maps: snapshot.maps });
    expect(state.size).toBe(33);
    expect(state.get("0")?.tables).toBe(tables);
    handleMessage(state, { type: "tables", key: "33", tables, maps: snapshot.maps });
    expect(state.size).toBe(1);
  });
});
