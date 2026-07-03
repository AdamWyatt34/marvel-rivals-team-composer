import type { Snapshot } from "../data/schema";
import { scoreTeamDetailed } from "./scorer";
import { sigmoid, type ScoringTables } from "./stats";
import type { Contribution } from "./types";

/**
 * Rule-based explanation from the scorer's own contributions — replaces the
 * Azure OpenAI explainer. Each contribution's log-odds delta is converted to
 * a win-probability delta at the final score, then the biggest positives and
 * negatives are rendered as sentences.
 */

const TOP_POSITIVE = 3;
const TOP_NEGATIVE = 2;

export interface Explanation {
  winProbability: number;
  lines: string[];
}

export function explainTeam(
  tables: ScoringTables,
  snapshot: Snapshot,
  ourIds: readonly string[],
  enemyIds: readonly string[],
  mapId?: string | null,
  bannedIds: readonly string[] = [],
): Explanation {
  const detailed = scoreTeamDetailed(
    tables,
    ourIds,
    enemyIds,
    mapId,
    bannedIds,
  );
  const mapName =
    mapId != null
      ? (snapshot.maps.find((m) => m.id === mapId)?.name ?? mapId)
      : null;

  const withDelta = detailed.contributions
    .map((c) => ({
      contribution: c,
      deltaP: sigmoid(detailed.z) - sigmoid(detailed.z - c.deltaLogOdds),
    }))
    .filter((c) => Math.abs(c.deltaP) >= 0.001);

  const positives = withDelta
    .filter((c) => c.deltaP > 0)
    .sort((a, b) => b.deltaP - a.deltaP)
    .slice(0, TOP_POSITIVE);
  const negatives = withDelta
    .filter((c) => c.deltaP < 0)
    .sort((a, b) => a.deltaP - b.deltaP)
    .slice(0, TOP_NEGATIVE);

  const lines = [...positives, ...negatives].map(({ contribution, deltaP }) =>
    renderLine(contribution, deltaP, mapName),
  );

  return { winProbability: detailed.prob, lines };
}

function renderLine(
  c: Contribution,
  deltaP: number,
  mapName: string | null,
): string {
  const pct = `${deltaP > 0 ? "+" : ""}${(deltaP * 100).toFixed(1)}%`;
  switch (c.kind) {
    case "hero":
      return deltaP >= 0
        ? `${c.label} is performing well at this rank (${pct})`
        : `${c.label} is underperforming at this rank (${pct})`;
    case "enemy":
      return deltaP >= 0
        ? `Enemy ${c.label} is weak at this rank (${pct})`
        : `Enemy ${c.label} is a strong pick (${pct})`;
    case "matchup":
      return deltaP >= 0
        ? `${c.label} is favorable (${pct})`
        : `${c.label} is unfavorable (${pct})`;
    case "field":
      return deltaP >= 0
        ? `${c.label} matches up well into the likely meta (${pct})`
        : `${c.label} matches up poorly into the likely meta (${pct})`;
    case "map":
      return deltaP >= 0
        ? `${c.label} performs well on ${mapName ?? "this map"} (${pct})`
        : `${c.label} underperforms on ${mapName ?? "this map"} (${pct})`;
    case "teamup":
      return `${c.label} team-up active (${pct})`;
    case "shape":
      return deltaP >= 0
        ? `${c.label} compositions win at this rank (${pct})`
        : `${c.label} compositions underperform at this rank (${pct})`;
    case "coverage":
      return `No good answer to ${c.label} (${pct})`;
    case "pair":
      return deltaP >= 0
        ? `${c.label} overperform together (${pct})`
        : `${c.label} underperform together (${pct})`;
  }
}
