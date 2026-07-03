import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snapshotSchema } from "../../data/schema";
import { buildBackups } from "../backups";
import { suggestBans } from "../bans";
import { compose } from "../compose";
import { explainTeam } from "../explain";
import { buildScoringTables } from "../stats";
import { DEFAULT_RULES } from "../types";

/** End-to-end over the real committed snapshot: Adam locks Thor, his duo locks Winter Soldier. */

const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/data/snapshot.json",
);

describe("engine against the real snapshot", () => {
  const snapshot = snapshotSchema.parse(
    JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")),
  );
  const tables = buildScoringTables(snapshot, "all");

  it("composes a full flow (compose + backups + bans + explain) quickly", () => {
    const started = performance.now();

    const result = compose(tables, {
      myLockedIds: ["thor", "winter-soldier"],
      enemyIds: ["hela", "luna-snow"],
      bannedIds: ["phoenix"],
      mapId: "1291",
      rules: DEFAULT_RULES,
    });
    const teamIds = result.team.map((h) => h.id);
    const backups = buildBackups(
      tables,
      result.team,
      ["hela", "luna-snow"],
      ["phoenix"],
      DEFAULT_RULES,
      "1291",
    );
    const bans = suggestBans(
      tables,
      ["thor", "winter-soldier"],
      ["hela", "luna-snow"],
      ["phoenix"],
      DEFAULT_RULES,
      3,
      "1291",
    );
    const explanation = explainTeam(
      tables,
      snapshot,
      teamIds,
      ["hela", "luna-snow"],
      "1291",
    );

    const elapsed = performance.now() - started;

    expect(teamIds).toContain("thor");
    expect(teamIds).toContain("winter-soldier");
    expect(teamIds).toHaveLength(6);
    expect(teamIds).not.toContain("phoenix");
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
    expect(result.prob).toBeGreaterThan(0.2);
    expect(result.prob).toBeLessThan(0.8);
    expect(Object.keys(backups).length).toBeGreaterThan(0);
    expect(bans.length).toBeLessThanOrEqual(3);
    for (const ban of bans) expect(teamIds).not.toContain(ban);
    expect(explanation.lines.length).toBeGreaterThan(0);

    expect(elapsed).toBeLessThan(2000);
  });

  it("every tier band builds usable tables", () => {
    for (const band of [
      "all",
      "gold+",
      "platinum+",
      "diamond+",
      "grandmaster+",
    ] as const) {
      const t = buildScoringTables(snapshot, band);
      expect(t.strength.size).toBeGreaterThanOrEqual(35);
      expect(t.pBar).toBeGreaterThan(0.45);
      expect(t.pBar).toBeLessThan(0.55);
    }
  });
});
