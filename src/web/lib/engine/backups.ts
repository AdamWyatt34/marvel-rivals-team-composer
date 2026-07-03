import { meetsHardRules } from "./compose";
import { scoreTeam } from "./scorer";
import type { ScoringTables } from "./stats";
import type { EngineHero, Role, TeamRules } from "./types";

/**
 * Per-role single-swap alternatives, ported from BackupsBuilder.
 * Deliberate change: the keep-tolerance is 0.1 log-odds below the best swap
 * instead of the original multiplicative 5% of win probability — around
 * p ~= 0.5 a multiplicative cutoff barely filters anything.
 */

const TOLERANCE_LOG_ODDS = 0.1;
const ROLES: Role[] = ["Vanguard", "Duelist", "Strategist"];

export function buildBackups(
  tables: ScoringTables,
  team: readonly EngineHero[],
  enemyIds: readonly string[],
  bannedIds: readonly string[],
  rules: TeamRules,
  mapId?: string | null,
  maxPerRole = 3,
): Record<string, string[]> {
  const teamIds = new Set(team.map((h) => h.id));
  const banned = new Set(bannedIds);
  const pool = [...tables.heroes.values()].filter(
    (h) => !banned.has(h.id) && !teamIds.has(h.id),
  );

  const byRole: Record<string, string[]> = {};

  for (const role of ROLES) {
    const indices = team
      .map((h, i) => (h.role === role ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length === 0) continue;

    const candidates = pool.filter((h) => h.role === role);
    if (candidates.length === 0) continue;

    const scored: Array<{ id: string; z: number }> = [];
    for (const idx of indices) {
      for (const candidate of candidates) {
        const mutated = [...team];
        mutated[idx] = candidate;
        if (!meetsHardRules(mutated, rules)) continue;
        const { z } = scoreTeam(
          tables,
          mutated.map((h) => h.id),
          enemyIds,
          mapId,
          bannedIds,
        );
        scored.push({ id: candidate.id, z });
      }
    }
    if (scored.length === 0) continue;

    const best = Math.max(...scored.map((s) => s.z));
    const keep = scored
      .filter((s) => s.z >= best - TOLERANCE_LOG_ODDS)
      .sort((a, b) => b.z - a.z)
      .map((s) => s.id);
    const unique = [...new Set(keep)].slice(0, maxPerRole);
    if (unique.length > 0) byRole[role] = unique;
  }

  return byRole;
}
