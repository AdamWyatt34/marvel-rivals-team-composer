export {
  buildScoringTables,
  SCORING_PARAMS,
  TIER_BANDS,
  type ScoringTables,
  type TierBand,
} from "./stats";
export { calibratedProb, scoreTeam, scoreTeamDetailed } from "./scorer";
export {
  compose,
  meetsHardRules,
  type ComposeInput,
  type ComposeResult,
} from "./compose";
export { buildBackups } from "./backups";
export { suggestBans, threatScore } from "./bans";
export { threatsAgainst, type ThreatInfo } from "./threats";
export { explainTeam, type Explanation } from "./explain";
export {
  DEFAULT_RULES,
  NoFeasibleTeamError,
  type Contribution,
  type EngineHero,
  type Role,
  type TeamRules,
} from "./types";
