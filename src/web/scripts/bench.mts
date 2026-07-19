import { readFileSync } from "node:fs";
import { snapshotSchema } from "../lib/data/schema";
import { pairsTableSchema } from "../lib/data/pairs-schema";
import { buildScoringTables } from "../lib/engine/stats";
import { scoreTeam } from "../lib/engine/scorer";
import { compose } from "../lib/engine/compose";
import { DEFAULT_RULES } from "../lib/engine/types";

const snapshot = snapshotSchema.parse(
  JSON.parse(readFileSync("public/data/snapshot.json", "utf8")),
);
const pairs = pairsTableSchema.parse(
  JSON.parse(readFileSync("public/data/pairs.json", "utf8")),
);
const tables = buildScoringTables(snapshot, "platinum+", pairs);

const heroes = [...tables.heroes.keys()];
const teamA = heroes.slice(0, 6);
const teamB = heroes.slice(6, 12);

let t0 = performance.now();
for (let i = 0; i < 20000; i++) scoreTeam(tables, teamA, teamB, "1291");
console.log(`scoreTeam x20k: ${(performance.now() - t0).toFixed(0)}ms`);

t0 = performance.now();
for (let i = 0; i < 10; i++) {
  compose(tables, {
    myLockedIds: ["thor", "winter-soldier"],
    enemyIds: ["hela", "luna-snow"],
    bannedIds: ["phoenix"],
    mapId: "1291",
    rules: DEFAULT_RULES,
  });
}
console.log(`compose x10: ${(performance.now() - t0).toFixed(0)}ms`);
