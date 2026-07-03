import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotSchema, type Snapshot } from "../../lib/data/schema";
import { fetchMatchups, fetchStats } from "./rivalsmeta";
import { normalize } from "./normalize";
import { validateSnapshot } from "./validate";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(SCRIPT_DIR, "../../public/data/snapshot.json");

async function main() {
  const now = new Date();

  const previous: Snapshot | null = existsSync(SNAPSHOT_PATH)
    ? snapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")))
    : null;

  const { stats } = await fetchStats(now);
  await new Promise((r) => setTimeout(r, 1000)); // courtesy delay between requests
  const matchups = await fetchMatchups();

  const snapshot = normalize(stats, matchups, now);
  validateSnapshot(snapshot, previous);

  if (
    previous != null &&
    previous.sourceTimestamp === snapshot.sourceTimestamp
  ) {
    console.log(
      `Source data unchanged (timestamp ${snapshot.sourceTimestamp}); nothing to do.`,
    );
    return;
  }

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot) + "\n");
  console.log(
    `Wrote ${SNAPSHOT_PATH} — ${snapshot.season.label}, source timestamp ` +
      `${new Date(snapshot.sourceTimestamp * 1000).toISOString()}, ` +
      `${snapshot.heroes.length} heroes, ${Object.keys(snapshot.matchups).length} matchup rows`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
