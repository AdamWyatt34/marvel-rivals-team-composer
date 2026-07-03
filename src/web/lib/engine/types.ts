export type Role = "Vanguard" | "Duelist" | "Strategist";

export interface EngineHero {
  id: string;
  name: string;
  role: Role;
}

export interface TeamRules {
  minStrategists: number;
  minVanguards: number;
  minDuelists: number;
  teamSize: number;
}

export const DEFAULT_RULES: TeamRules = {
  minStrategists: 2,
  minVanguards: 1,
  minDuelists: 1,
  teamSize: 6,
};

export class NoFeasibleTeamError extends Error {
  constructor() {
    super("No feasible team meets constraints with the given locks & bans.");
    this.name = "NoFeasibleTeamError";
  }
}

export type ContributionKind =
  | "hero"
  | "enemy"
  | "matchup"
  | "map"
  | "teamup"
  | "shape"
  | "coverage"
  | "pair";

export interface Contribution {
  kind: ContributionKind;
  /** The heroes (or hero+map / team-up members) this term is about. */
  ids: string[];
  label: string;
  deltaLogOdds: number;
}

export interface TeamScore {
  prob: number;
  z: number;
}

export interface DetailedTeamScore extends TeamScore {
  contributions: Contribution[];
}
