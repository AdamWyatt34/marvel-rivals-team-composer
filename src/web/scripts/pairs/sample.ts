import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNuxtPage, routeData } from "../ingest/devalue-parse";
import { USER_AGENT } from "../ingest/rivalsmeta";
import type { SnapshotHero } from "../../lib/data/schema";
import { pairsTableSchema } from "../../lib/data/pairs-schema";
import { aggregatePairs, type CompRow } from "./aggregate";
import { MrApiClient, RateLimitedError, type MatchDetails } from "./mrapi";

/**
 * Daily match sampler: pulls recent competitive matches of leaderboard
 * players from marvelrivalsapi.com, appends the 6v6 comps to
 * data/pairs/comps-YYYY-MM.jsonl, and recomputes the pair-count table the
 * engine's synergy term consumes.
 *
 * Needs MRAPI_KEY. Exits 0 with a notice when it's missing so the workflow
 * can land before the secret exists.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const PAIRS_DIR = resolve(REPO_ROOT, "data/pairs");
const STATE_PATH = resolve(PAIRS_DIR, "state.json");
const PAIRS_TABLE_PATH = resolve(SCRIPT_DIR, "../../public/data/pairs.json");
const REFERENCE_HEROES = resolve(REPO_ROOT, "data/reference/heroes.json");

const MAX_REQUESTS = Number(process.env.SAMPLE_MAX_REQUESTS ?? 2500);
const PLAYERS_PER_RUN = 150;
/** The /update indexing endpoint is heavily rate-limited; pace and cap it. */
const UPDATE_NUDGES_PER_RUN = 20;
const UPDATE_NUDGE_SPACING_MS = 10_000;
const WINDOW_DAYS = 60;
/** Forget seen-match ids and player cursors older than this. */
const STATE_RETENTION_DAYS = 70;

interface State {
  /** player uid -> newest match_time_stamp already ingested */
  players: Record<string, number>;
  /** match uid -> epoch seconds when first seen */
  seenMatches: Record<string, number>;
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) return { players: {}, seenMatches: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}

/** Top-ranked player uids from RivalsMeta's leaderboard page (no key needed). */
async function fetchLeaderboardUids(): Promise<string[]> {
  const res = await fetch("https://rivalsmeta.com/leaderboard", {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`leaderboard returned ${res.status}`);
  const payload = routeData<{ players?: Array<{ uid: string }> }>(
    parseNuxtPage(await res.text()),
  );
  const uids = (payload.players ?? [])
    .map((p) => String(p.uid))
    .filter(Boolean);
  if (uids.length < 50) {
    throw new Error(
      `leaderboard payload has only ${uids.length} players — page changed?`,
    );
  }
  return uids;
}

/** Two 6-slug teams + winner from match details; null if the match is unusable. */
export function compFromDetails(
  details: MatchDetails,
  slugById: Map<number, string>,
  endEpoch: number,
): CompRow | null {
  const players = details.match_players ?? [];
  if (players.length !== 12) return null;

  const camps = [...new Set(players.map((p) => p.camp))];
  if (camps.length !== 2) return null;
  const [campA, campB] = camps;

  const team = (camp: number) => players.filter((p) => p.camp === camp);
  const teamA = team(campA);
  const teamB = team(campB);
  if (teamA.length !== 6 || teamB.length !== 6) return null;

  const slugs = (side: typeof teamA) => {
    const out: string[] = [];
    for (const p of side) {
      const slug = slugById.get(p.cur_hero_id);
      if (slug == null) return null;
      out.push(slug);
    }
    return out;
  };
  const a = slugs(teamA);
  const b = slugs(teamB);
  if (a == null || b == null) return null;

  const aWins = teamA.filter((p) => p.is_win === 1).length;
  const bWins = teamB.filter((p) => p.is_win === 1).length;
  if (aWins === bWins) return null; // draw or inconsistent data
  return { t: endEpoch, w: aWins > bWins ? "a" : "b", a, b };
}

function loadCompRows(): CompRow[] {
  if (!existsSync(PAIRS_DIR)) return [];
  const rows: CompRow[] = [];
  for (const file of readdirSync(PAIRS_DIR)) {
    if (!/^comps-\d{4}-\d{2}\.jsonl$/.test(file)) continue;
    for (const line of readFileSync(resolve(PAIRS_DIR, file), "utf8").split(
      "\n",
    )) {
      if (line.trim().length === 0) continue;
      rows.push(JSON.parse(line) as CompRow);
    }
  }
  return rows;
}

async function main() {
  const apiKey = process.env.MRAPI_KEY;
  if (apiKey == null || apiKey.trim() === "") {
    console.log(
      "MRAPI_KEY not set — skipping match sampling (add the repo secret to enable).",
    );
    return;
  }

  const now = new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const heroes = JSON.parse(
    readFileSync(REFERENCE_HEROES, "utf8"),
  ) as SnapshotHero[];
  const slugById = new Map(heroes.map((h) => [h.rivalsMetaId, h.id]));

  const state = loadState();
  const client = new MrApiClient(apiKey, MAX_REQUESTS);
  const newRows: CompRow[] = [];

  try {
    const uids = await fetchLeaderboardUids();
    // visit the least-recently-sampled players first
    const ordered = [...uids]
      .sort((x, y) => (state.players[x] ?? 0) - (state.players[y] ?? 0))
      .slice(0, PLAYERS_PER_RUN);

    const pendingMatches = new Map<string, number>(); // uid -> end epoch
    let unindexed = 0;
    let nudges = 0;
    let nudgesEnabled = true;
    for (const uid of ordered) {
      if (client.budgetLeft <= pendingMatches.size + 10) break;
      const since = state.players[uid];
      let history;
      try {
        history = await client.matchHistory(uid, since);
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        // The API 500s for players it hasn't indexed yet — nudge its indexer
        // (heavily rate-limited, so paced and capped) and move on. History
        // scanning continues regardless.
        unindexed++;
        if (nudgesEnabled && nudges < UPDATE_NUDGES_PER_RUN) {
          try {
            await client.requestPlayerUpdate(uid);
            nudges++;
            await new Promise((r) => setTimeout(r, UPDATE_NUDGE_SPACING_MS));
          } catch (nudgeErr) {
            if (nudgeErr instanceof RateLimitedError) {
              console.warn(
                "update endpoint rate-limited — no more indexing nudges this run",
              );
              nudgesEnabled = false;
            }
          }
        }
        continue;
      }
      let newest = since ?? 0;
      for (const item of history) {
        if (item.match_time_stamp > newest) newest = item.match_time_stamp;
        if (since != null && item.match_time_stamp <= since) continue;
        if (state.seenMatches[item.match_uid] != null) continue;
        pendingMatches.set(item.match_uid, item.match_time_stamp);
      }
      state.players[uid] = newest;
    }

    console.log(
      `history pass done: ${client.used} requests, ${pendingMatches.size} new matches queued, ` +
        `${unindexed} players unindexed (${nudges} indexing nudges sent)`,
    );

    for (const [matchUid, endEpoch] of pendingMatches) {
      if (client.budgetLeft <= 0) break;
      let details;
      try {
        details = await client.matchDetails(matchUid);
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        continue; // skip matches the API can't serve; don't mark them seen
      }
      state.seenMatches[matchUid] = nowEpoch;
      if (details == null) continue;
      const row = compFromDetails(details, slugById, endEpoch);
      if (row != null) newRows.push(row);
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      console.warn("Rate limit reached — saving progress and stopping early.");
    } else {
      throw err;
    }
  }

  // prune old state
  const cutoff = nowEpoch - STATE_RETENTION_DAYS * 86400;
  for (const [uid, epoch] of Object.entries(state.seenMatches)) {
    if (epoch < cutoff) delete state.seenMatches[uid];
  }

  mkdirSync(PAIRS_DIR, { recursive: true });
  if (newRows.length > 0) {
    const month = now.toISOString().slice(0, 7);
    appendFileSync(
      resolve(PAIRS_DIR, `comps-${month}.jsonl`),
      newRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
  writeFileSync(STATE_PATH, JSON.stringify(state) + "\n");

  const table = aggregatePairs(loadCompRows(), now, WINDOW_DAYS);
  pairsTableSchema.parse(table);
  writeFileSync(PAIRS_TABLE_PATH, JSON.stringify(table) + "\n");

  console.log(
    `Sampled ${newRows.length} new matches (${client.used} requests). ` +
      `Pair table now covers ${table.totalMatches} matches / ${Object.keys(table.pairs).length} pairs.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
