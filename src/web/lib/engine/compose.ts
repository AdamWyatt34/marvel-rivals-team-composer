import { scoreTeam } from "./scorer";
import type { ScoringTables } from "./stats";
import { NoFeasibleTeamError, type EngineHero, type TeamRules } from "./types";

/**
 * Beam-search composer, ported from Composer.Core's Composer.Compose.
 * Deliberate changes from the C# original:
 *  - minDuelists is enforced (the original only had strategists/vanguards)
 *  - beams are deduped by hero set (the original kept permutations of the
 *    same partial team, wasting beam slots)
 *  - the priors tie-break is gone: hero strength is a first-class score term
 *
 * Enemy-locked heroes stay in our pool on purpose — Marvel Rivals allows the
 * same hero on both teams.
 */

export interface ComposeInput {
  myLockedIds: readonly string[];
  enemyIds: readonly string[];
  bannedIds: readonly string[];
  mapId?: string | null;
  rules: TeamRules;
  beamWidth?: number;
}

export interface ComposeResult {
  team: EngineHero[];
  prob: number;
  z: number;
}

interface Beam {
  team: EngineHero[];
  z: number;
}

export function compose(
  tables: ScoringTables,
  input: ComposeInput,
): ComposeResult {
  const { rules, mapId = null, beamWidth = 32 } = input;
  const banned = new Set(input.bannedIds);
  const lockedSet = new Set(input.myLockedIds);

  const locked = input.myLockedIds.map((id) => {
    const hero = tables.heroes.get(id);
    if (hero == null) throw new Error(`Unknown locked hero id: ${id}`);
    return hero;
  });
  const enemyIds = input.enemyIds.filter((id) => tables.heroes.has(id));

  const pool = [...tables.heroes.values()].filter(
    (h) => !banned.has(h.id) && !lockedSet.has(h.id),
  );

  const score = (team: readonly EngineHero[]) =>
    scoreTeam(
      tables,
      team.map((h) => h.id),
      enemyIds,
      mapId,
    );

  let beams: Beam[] = [{ team: [...locked], z: score(locked).z }];
  const completed: Beam[] = [];

  while (beams.length > 0 && beams[0].team.length < rules.teamSize) {
    const next: Beam[] = [];
    const seen = new Set<string>();

    for (const beam of beams) {
      const slotsLeft = rules.teamSize - beam.team.length;
      if (!stillFeasible(beam.team, rules, pool, slotsLeft)) continue;

      const need = unmetNeeds(beam.team, rules);
      const inTeam = new Set(beam.team.map((h) => h.id));
      const candidates = pool.filter((h) => !inTeam.has(h.id));
      const priority = candidates.filter(
        (h) =>
          (need.strategists > 0 && h.role === "Strategist") ||
          (need.vanguards > 0 && h.role === "Vanguard") ||
          (need.duelists > 0 && h.role === "Duelist"),
      );
      const prioritySet = new Set(priority.map((h) => h.id));
      const ordered = [
        ...priority,
        ...candidates.filter((h) => !prioritySet.has(h.id)),
      ];

      for (const hero of ordered) {
        const team = [...beam.team, hero];
        if (team.length === rules.teamSize) {
          if (meetsHardRules(team, rules))
            completed.push({ team, z: score(team).z });
          continue;
        }
        const key = team
          .map((h) => h.id)
          .sort()
          .join("+");
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ team, z: score(team).z });
      }
    }

    if (next.length === 0) break;
    next.sort((a, b) => b.z - a.z);
    beams = next.slice(0, beamWidth);
  }

  const finals = (completed.length > 0 ? completed : beams).filter((b) =>
    meetsHardRules(b.team, rules),
  );
  if (finals.length === 0) throw new NoFeasibleTeamError();

  const best = finals.reduce((a, b) => (b.z > a.z ? b : a));
  return {
    team: best.team,
    z: best.z,
    prob: scoreTeam(
      tables,
      best.team.map((h) => h.id),
      enemyIds,
      mapId,
    ).prob,
  };
}

export function meetsHardRules(
  team: readonly EngineHero[],
  rules: TeamRules,
): boolean {
  const count = (role: EngineHero["role"]) =>
    team.filter((h) => h.role === role).length;
  return (
    count("Strategist") >= rules.minStrategists &&
    count("Vanguard") >= rules.minVanguards &&
    count("Duelist") >= rules.minDuelists &&
    team.length === rules.teamSize
  );
}

function unmetNeeds(team: readonly EngineHero[], rules: TeamRules) {
  const count = (role: EngineHero["role"]) =>
    team.filter((h) => h.role === role).length;
  return {
    strategists: Math.max(0, rules.minStrategists - count("Strategist")),
    vanguards: Math.max(0, rules.minVanguards - count("Vanguard")),
    duelists: Math.max(0, rules.minDuelists - count("Duelist")),
  };
}

function stillFeasible(
  partial: readonly EngineHero[],
  rules: TeamRules,
  pool: readonly EngineHero[],
  slotsLeft: number,
): boolean {
  const need = unmetNeeds(partial, rules);
  const inTeam = new Set(partial.map((h) => h.id));
  const avail = (role: EngineHero["role"]) =>
    pool.filter((h) => h.role === role && !inTeam.has(h.id)).length;
  return (
    need.strategists <= avail("Strategist") &&
    need.vanguards <= avail("Vanguard") &&
    need.duelists <= avail("Duelist") &&
    slotsLeft >= need.strategists + need.vanguards + need.duelists
  );
}
