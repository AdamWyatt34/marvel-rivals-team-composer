import type { PairsTable } from "../data/pairs-schema";
import type { Snapshot } from "../data/schema";
import type { EngineHero, Role } from "./types";

/**
 * Empirical-Bayes scoring tables.
 *
 * Every rate is shrunk toward a baseline with pseudo-count strength M:
 * shrunk = (wins + M * p0) / (matches + M). A hero with few games contributes
 * ~0 signal; a popular hero's rate is barely moved. This is what de-biases
 * raw win rates against pick-rate effects — uncertainty is discounted, not
 * popularity.
 *
 * All deltas live in log-odds space so they compose additively in the scorer.
 */

export const SCORING_PARAMS = {
  /** Pseudo-count prior strengths (games). */
  M_HERO: 400,
  M_MATCHUP: 250,
  M_MAP: 150,
  M_TEAMUP: 250,
  M_SHAPE: 500,
  /** Term weights in the additive model. */
  K_HERO: 0.85,
  K_MATCHUP: 0.8,
  K_MAP: 0.5,
  K_TEAMUP: 0.4,
  K_SHAPE: 0.5,
  /**
   * Coverage: penalize teams with no answer (best matchup still negative)
   * to a likely threat. Only gaps are penalized; redundant answers earn
   * nothing.
   */
  K_COVERAGE: 0.6,
  META_THREAT_COUNT: 8,
  /**
   * Pair synergy from sampled matches: observed pair WR shrunk toward the
   * pair's EXPECTED WR given both heroes' individual strengths, so only
   * genuine over/under-performance together counts. Pairs covered by an
   * active team-up are excluded (already scored by the team-up term).
   */
  M_PAIR: 300,
  K_PAIR: 0.6,
  PAIR_SYNERGY_CAP: 0.2,
  /** Team-up bonus clamps: rarely hurt, and their stats inherit the same
   * specialist bias as hero win rates, so cap the upside too. */
  TEAMUP_MIN: -0.1,
  TEAMUP_MAX: 0.2,
  /**
   * Soft cap on hero strength (log-odds; 0.15 ~ a 53.7% hero at a 50% mean).
   * Extreme win rates on niche heroes are specialist/one-trick selection
   * bias, not team value — shrinkage can't fix that (their samples are
   * large), so strengths are tanh-compressed toward the cap instead.
   */
  HERO_STRENGTH_CAP: 0.15,
  /**
   * Heroes picked less than the median share get a proportionally stronger
   * shrinkage prior (specialists supply most of their games), capped at 8x.
   */
  PICK_SHARE_PRIOR_MAX: 8,
};

/**
 * Rank bands the user can score at. Values are snapshot bucket codes
 * (1=Bronze … 9=One Above All; 0 carries unbadged residual data).
 * Bands rather than single tiers keep sample sizes healthy.
 */
export const TIER_BANDS = {
  all: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
  "gold+": ["3", "4", "5", "6", "7", "8", "9"],
  "platinum+": ["4", "5", "6", "7", "8", "9"],
  "diamond+": ["5", "6", "7", "8", "9"],
  "grandmaster+": ["6", "7", "8", "9"],
} as const;

export type TierBand = keyof typeof TIER_BANDS;

/** The matchup matrix source aggregates Diamond+ regardless of chosen band. */
const MATCHUP_SOURCE_BAND: TierBand = "diamond+";

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function shrunk(
  wins: number,
  matches: number,
  p0: number,
  m: number,
): number {
  return (wins + m * p0) / (matches + m);
}

interface TeamUpVariant {
  members: string[];
  bonus: number;
}

export interface ActiveTeamUp {
  id: number;
  name: string;
  /** Variants sorted most-members-first; first subset match wins. */
  variants: TeamUpVariant[];
}

export interface ScoringTables {
  band: TierBand;
  pBar: number;
  zBar: number;
  heroes: Map<string, EngineHero>;
  /** s_h — shrunk log-odds delta vs the band's global mean. */
  strength: Map<string, number>;
  /** "h|e" -> m_he: h's log-odds edge when e is on the enemy team. */
  matchup: Map<string, number>;
  /** "h|mapId" -> d: h's log-odds delta on that map vs h's own baseline. */
  mapDelta: Map<string, number>;
  teamUps: ActiveTeamUp[];
  /** Fraction of the band's matches in which the hero was banned. */
  banRate: Map<string, number>;
  /** "V-D-S" (e.g. "2-2-2") -> log-odds delta of that role shape vs the band mean. */
  shapeDelta: Map<string, number>;
  /**
   * The heroes an unknown enemy is most likely to field in this band
   * (ranked by pick volume + bans) — the threat set for coverage scoring
   * when enemy picks aren't known yet.
   */
  metaThreats: string[];
  /** "a+b" (sorted slugs) -> log-odds synergy beyond individual strengths. */
  pairSynergy: Map<string, number>;
  /** Mirror-excluded games per hero in this band (sample size for uncertainty). */
  strengthSamples: Map<string, number>;
  /** Fraction of hero-slots the hero occupies in this band (popularity). */
  pickShare: Map<string, number>;
}

function aggregateBand(snapshot: Snapshot, band: TierBand) {
  const perHero = new Map<
    string,
    { matches: number; wrMatches: number; wrWins: number; bans: number }
  >();
  for (const code of TIER_BANDS[band]) {
    const bucket = snapshot.stats[code];
    if (bucket == null) continue;
    for (const [slug, s] of Object.entries(bucket)) {
      const agg = perHero.get(slug) ?? {
        matches: 0,
        wrMatches: 0,
        wrWins: 0,
        bans: 0,
      };
      agg.matches += s.matches;
      agg.wrMatches += s.wrMatches;
      agg.wrWins += s.wrWins;
      agg.bans += s.bans ?? 0;
      perHero.set(slug, agg);
    }
  }
  return perHero;
}

function shrunkHeroRates(
  perHero: Map<string, { matches: number; wrMatches: number; wrWins: number }>,
  pBar: number,
): Map<string, number> {
  const rates = new Map<string, number>();
  const shares = [...perHero.values()]
    .map((a) => a.matches)
    .sort((a, b) => a - b);
  const medianMatches =
    shares.length > 0 ? shares[Math.floor(shares.length / 2)] : 0;
  for (const [slug, agg] of perHero) {
    // Below-median pick volume -> proportionally stronger prior: niche heroes'
    // games come disproportionately from specialists.
    const factor =
      agg.matches > 0 && medianMatches > 0
        ? Math.min(
            SCORING_PARAMS.PICK_SHARE_PRIOR_MAX,
            Math.max(1, medianMatches / agg.matches),
          )
        : 1;
    rates.set(
      slug,
      shrunk(agg.wrWins, agg.wrMatches, pBar, SCORING_PARAMS.M_HERO * factor),
    );
  }
  return rates;
}

/** tanh soft cap: preserves ordering, compresses specialist-biased outliers. */
export function capStrength(rawLogOddsDelta: number): number {
  const cap = SCORING_PARAMS.HERO_STRENGTH_CAP;
  return cap * Math.tanh(rawLogOddsDelta / cap);
}

function globalMean(
  perHero: Map<string, { wrMatches: number; wrWins: number }>,
): number {
  let matches = 0;
  let wins = 0;
  for (const agg of perHero.values()) {
    matches += agg.wrMatches;
    wins += agg.wrWins;
  }
  return matches > 0 ? wins / matches : 0.5;
}

export function buildScoringTables(
  snapshot: Snapshot,
  band: TierBand,
  pairs: PairsTable | null = null,
): ScoringTables {
  const perHero = aggregateBand(snapshot, band);
  const pBar = globalMean(perHero);
  const zBar = logit(pBar);

  const heroes = new Map<string, EngineHero>(
    snapshot.heroes.map((h) => [
      h.id,
      { id: h.id, name: h.name, role: h.role as Role },
    ]),
  );

  const heroRate = shrunkHeroRates(perHero, pBar);
  const strength = new Map<string, number>();
  // Raw (uncapped) strengths: used wherever we subtract member strength from
  // an observed group win rate (team-ups). Subtracting the CAPPED value there
  // would let the specialist bias removed from hero strength leak back in
  // through the group term.
  const rawStrength = new Map<string, number>();
  for (const [slug, rate] of heroRate) {
    const raw = logit(rate) - zBar;
    rawStrength.set(slug, raw);
    strength.set(slug, capStrength(raw));
  }

  // Matchup deltas are shrunk toward the hero's own baseline AT THE MATRIX'S
  // tier (Diamond+), not toward 0.5 — a sparse matchup then contributes ~0.
  const matchupHero = aggregateBand(snapshot, MATCHUP_SOURCE_BAND);
  const matchupPBar = globalMean(matchupHero);
  const matchupBaseline = shrunkHeroRates(matchupHero, matchupPBar);
  const matchup = new Map<string, number>();
  for (const [h, row] of Object.entries(snapshot.matchups)) {
    const base = matchupBaseline.get(h);
    if (base == null) continue;
    const zBase = logit(base);
    for (const [e, count] of Object.entries(row)) {
      const rate = shrunk(
        count.wins,
        count.matches,
        base,
        SCORING_PARAMS.M_MATCHUP,
      );
      matchup.set(`${h}|${e}`, logit(rate) - zBase);
    }
  }

  // Map deltas: source is all-ranks, so the baseline is the hero's all-ranks rate.
  const allHero = aggregateBand(snapshot, "all");
  const allBaseline = shrunkHeroRates(allHero, globalMean(allHero));
  const mapDelta = new Map<string, number>();
  for (const [h, perMap] of Object.entries(snapshot.heroMaps)) {
    const base = allBaseline.get(h);
    if (base == null) continue;
    const zBase = logit(base);
    for (const [mapId, count] of Object.entries(perMap)) {
      const rate = shrunk(
        count.wins,
        count.matches,
        base,
        SCORING_PARAMS.M_MAP,
      );
      mapDelta.set(`${h}|${mapId}`, logit(rate) - zBase);
    }
  }

  // Team-ups: per-variant bonuses at the chosen band, corrected for member
  // strength so team-ups of already-strong heroes don't double count.
  const variantAgg = new Map<string, { matches: number; wins: number }>();
  for (const code of TIER_BANDS[band]) {
    const bucket = snapshot.teamUpStats[code];
    if (bucket == null) continue;
    for (const [teamUpId, t] of Object.entries(bucket)) {
      for (const [combo, count] of Object.entries(t.variants)) {
        const key = `${teamUpId}:${combo}`;
        const agg = variantAgg.get(key) ?? { matches: 0, wins: 0 };
        agg.matches += count.matches;
        agg.wins += count.wins;
        variantAgg.set(key, agg);
      }
    }
  }
  const teamUps: ActiveTeamUp[] = [];
  for (const def of snapshot.teamUps) {
    if (!def.currentlyActive) continue;
    const variants: TeamUpVariant[] = [];
    for (const [key, agg] of variantAgg) {
      const [idPart, combo] = key.split(":");
      if (Number(idPart) !== def.id) continue;
      const members = combo.split("+");
      const rate = shrunk(agg.wins, agg.matches, pBar, SCORING_PARAMS.M_TEAMUP);
      // Expected WR with all members present shifts by the SUM of their
      // individual (raw) deltas under independence — only performance beyond
      // that is team-up value.
      const expectedDelta = members.reduce(
        (sum, m) => sum + (rawStrength.get(m) ?? 0),
        0,
      );
      const bonus = Math.min(
        SCORING_PARAMS.TEAMUP_MAX,
        Math.max(SCORING_PARAMS.TEAMUP_MIN, logit(rate) - zBar - expectedDelta),
      );
      variants.push({ members, bonus });
    }
    if (variants.length === 0) continue;
    variants.sort((a, b) => b.members.length - a.members.length);
    teamUps.push({ id: def.id, name: def.name, variants });
  }

  // Ban rates: bans / total matches in band (each match has ~12 hero slots).
  const totalMatches =
    [...perHero.values()].reduce((sum, agg) => sum + agg.matches, 0) / 12;
  const banRate = new Map<string, number>();
  for (const [slug, agg] of perHero) {
    banRate.set(slug, totalMatches > 0 ? agg.bans / totalMatches : 0);
  }

  // Role-shape prior: how role compositions (2-2-2, 1-3-2, …) perform in
  // this band, beyond the hard minimums.
  const shapeAgg = new Map<string, { matches: number; wins: number }>();
  for (const code of TIER_BANDS[band]) {
    const bucket = snapshot.roleShapes[code];
    if (bucket == null) continue;
    for (const [key, count] of Object.entries(bucket)) {
      const agg = shapeAgg.get(key) ?? { matches: 0, wins: 0 };
      agg.matches += count.matches;
      agg.wins += count.wins;
      shapeAgg.set(key, agg);
    }
  }
  const shapeDelta = new Map<string, number>();
  for (const [key, agg] of shapeAgg) {
    const rate = shrunk(agg.wins, agg.matches, pBar, SCORING_PARAMS.M_SHAPE);
    shapeDelta.set(key, logit(rate) - zBar);
  }

  // Likely-enemy threat set: most-fielded heroes weighted by ban pressure.
  const metaThreats = [...perHero.entries()]
    .map(([slug, agg]) => ({ slug, weight: agg.matches + 3 * agg.bans }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, SCORING_PARAMS.META_THREAT_COUNT)
    .map((x) => x.slug);

  const strengthSamples = new Map<string, number>();
  const pickShare = new Map<string, number>();
  const totalHeroMatches = [...perHero.values()].reduce(
    (sum, a) => sum + a.matches,
    0,
  );
  for (const [slug, agg] of perHero) {
    strengthSamples.set(slug, agg.wrMatches);
    pickShare.set(
      slug,
      totalHeroMatches > 0 ? agg.matches / totalHeroMatches : 0,
    );
  }

  // Pair synergy from sampled matches (optional data source). The pair's
  // baseline is the WR expected from both heroes' individual deltas, so a
  // pair of strong heroes isn't credited twice; team-up pairs are excluded.
  const pairSynergy = new Map<string, number>();
  if (pairs != null) {
    const teamUpPairs = new Set<string>();
    for (const def of snapshot.teamUps) {
      if (!def.currentlyActive) continue;
      for (let i = 0; i < def.heroes.length; i++) {
        for (let j = i + 1; j < def.heroes.length; j++) {
          const [x, y] = [def.heroes[i], def.heroes[j]].sort();
          teamUpPairs.add(`${x}+${y}`);
        }
      }
    }
    const cap = SCORING_PARAMS.PAIR_SYNERGY_CAP;
    for (const [key, count] of Object.entries(pairs.pairs)) {
      if (teamUpPairs.has(key)) continue;
      const [a, b] = key.split("+");
      const rateA = heroRate.get(a);
      const rateB = heroRate.get(b);
      if (rateA == null || rateB == null) continue;
      const expected = Math.min(
        0.95,
        Math.max(0.05, pBar + (rateA - pBar) + (rateB - pBar)),
      );
      const observed = shrunk(
        count.wins,
        count.matches,
        expected,
        SCORING_PARAMS.M_PAIR,
      );
      const syn = Math.min(
        cap,
        Math.max(-cap, logit(observed) - logit(expected)),
      );
      if (syn !== 0) pairSynergy.set(key, syn);
    }
  }

  return {
    band,
    pBar,
    zBar,
    heroes,
    strength,
    matchup,
    mapDelta,
    teamUps,
    banRate,
    shapeDelta,
    metaThreats,
    pairSynergy,
    strengthSamples,
    pickShare,
  };
}
