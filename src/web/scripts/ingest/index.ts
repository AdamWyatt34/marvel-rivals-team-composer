import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotSchema, type Snapshot } from "../../lib/data/schema";
import { fetchMatchups, fetchStats, fetchTeamComps } from "./rivalsmeta";
import { normalize } from "./normalize";
import { validateSnapshot } from "./validate";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(SCRIPT_DIR, "../../public/data/snapshot.json");

function loadPrevious(): Snapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  const parsed = snapshotSchema.safeParse(
    JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")),
  );
  if (!parsed.success) {
    // Older schema version on disk — treat as absent so it gets rewritten.
    console.warn(
      "Existing snapshot does not match the current schema; will rewrite.",
    );
    return null;
  }
  return parsed.data;
}

async function main() {
  const now = new Date();
  const previous = loadPrevious();

  const { stats } = await fetchStats(now);
  const pause = () => new Promise((r) => setTimeout(r, 1000)); // courtesy delay
  await pause();
  const matchups = await fetchMatchups();
  await pause();
  const teamComps = await fetchTeamComps();

  const snapshot = normalize(stats, matchups, teamComps, now);
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
