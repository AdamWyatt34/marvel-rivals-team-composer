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
  /**
   * Learned counter edges from the same sampled matches: observed WR of hero
   * x's team when y is on the enemy team, shrunk toward the WR expected from
   * both heroes' individual strengths. Overlaps conceptually with the
   * RivalsMeta matchup matrix — the backtest ablations arbitrate the weights.
   */
  M_COUNTER: 400,
  K_COUNTER: 0.3,
  COUNTER_CAP: 0.2,
  /**
   * Personal overlay (profile import): the player's own per-hero record,
   * shrunk hard (personal samples are tiny) toward the band's rate for that
   * hero and capped. Applied to the user's side only.
   */
  M_PERSONAL: 30,
  PERSONAL_CAP: 0.25,
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
  /**
   * Market-demand tilt: the community's revealed valuation of a hero is
   * their availability-adjusted pick share (picks scaled up for how often
   * they're ban-removed). Win rates alone invert the meta — mass-picked
   * staples regress below 50% while ignored heroes' specialist samples
   * inflate — so strength gets a log-scaled tilt toward demand:
   * K_DEMAND * ln(adjustedShare / medianShare), clamped to ±DEMAND_CAP.
   */
  K_DEMAND: 0.1,
  DEMAND_CAP: 0.15,
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
  /** hero id -> indexes into teamUps that hero can participate in. */
  teamUpsByHero: Map<string, number[]>;
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
  /** "h|e" -> h's learned log-odds edge (beyond strengths) vs enemy e. */
  counterEdge: Map<string, number>;
  /** Shrunk band win rate per hero (the baseline personal deltas shrink to). */
  heroRate: Map<string, number>;
  /** Per-hero log-odds delta from the player's own record; our side only. */
  personalDelta: Map<string, number>;
  /**
   * Probability calibration temperature: P = sigmoid(zBar + T*(z - zBar)).
   * Fitted by the backtest against real match outcomes; 1 = uncalibrated.
   */
  temperature: number;
  /**
   * P(an unknown enemy slot is this hero | hero available) — availability-
   * adjusted pick shares, normalized to sum 1. The scorer renormalizes at
   * score time after removing bans and known enemy picks.
   */
  fieldShare: Map<string, number>;
  /** Hero's expected matchup edge vs a fieldShare-weighted enemy slot. */
  fieldMatchup: Map<string, number>;
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
  temperature = 1,
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

  // Market-demand tilt: availability-adjusted pick share vs the median.
  // A hero banned in 60% of games would be picked ~2.5x as often if allowed,
  // so bans count as demand rather than suppressing it.
  const gamesInBand =
    [...perHero.values()].reduce((sum, a) => sum + a.matches, 0) / 12;
  const totalSlots = gamesInBand * 12;
  const adjustedShare = new Map<string, number>();
  for (const [slug, agg] of perHero) {
    const share = totalSlots > 0 ? agg.matches / totalSlots : 0;
    const availability =
      gamesInBand > 0 ? Math.max(0.1, 1 - agg.bans / gamesInBand) : 1;
    adjustedShare.set(slug, share / availability);
  }
  const shareValues = [...adjustedShare.values()].sort((a, b) => a - b);
  const medianShare = shareValues[Math.floor(shareValues.length / 2)] ?? 0;
  const demandDelta = (slug: string): number => {
    const share = adjustedShare.get(slug) ?? 0;
    if (share <= 0 || medianShare <= 0) return -SCORING_PARAMS.DEMAND_CAP;
    const tilt = SCORING_PARAMS.K_DEMAND * Math.log(share / medianShare);
    return Math.min(
      SCORING_PARAMS.DEMAND_CAP,
      Math.max(-SCORING_PARAMS.DEMAND_CAP, tilt),
    );
  };

  const strength = new Map<string, number>();
  // Raw (uncapped) WR-only strengths: used wherever we subtract member
  // strength from an observed group win rate (team-ups) — those observations
  // embed the actual (specialist) players, so the demand tilt must NOT be in
  // the value we subtract, and subtracting the CAPPED value would let the
  // specialist bias leak back in through the group term.
  const rawStrength = new Map<string, number>();
  for (const [slug, rate] of heroRate) {
    const raw = logit(rate) - zBar;
    rawStrength.set(slug, raw);
    strength.set(slug, capStrength(raw + demandDelta(slug)));
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

  // Likely-field distribution and each hero's expected edge into it: what an
  // unknown enemy slot looks like before any locks. Powers the matchup term's
  // unknown-slot fill so heroes that farm the actual meta outrank heroes that
  // only beat off-meta picks.
  const fieldShare = new Map<string, number>();
  const fieldMatchup = new Map<string, number>();
  const shareSum = [...adjustedShare.values()].reduce((sum, s) => sum + s, 0);
  if (shareSum > 0) {
    for (const [slug, share] of adjustedShare) {
      fieldShare.set(slug, share / shareSum);
    }
    for (const h of heroes.keys()) {
      let expected = 0;
      for (const [e, share] of fieldShare) {
        if (e === h) continue; // mirror slots are neutral
        expected += share * (matchup.get(`${h}|${e}`) ?? 0);
      }
      if (expected !== 0) fieldMatchup.set(h, expected);
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
  // Per-hero index so the scorer only checks team-ups a present hero can
  // trigger — with 100+ active team-ups the full scan dominated scoring.
  const teamUpsByHero = new Map<string, number[]>();
  teamUps.forEach((teamUp, idx) => {
    const members = new Set(teamUp.variants.flatMap((v) => v.members));
    for (const m of members) {
      const list = teamUpsByHero.get(m);
      if (list == null) teamUpsByHero.set(m, [idx]);
      else list.push(idx);
    }
  });

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

  // Learned counter edges, same recipe as pair synergy but cross-team: the
  // expected WR of x-vs-y is the strength difference, so only residual
  // counter effect survives shrinkage.
  const counterEdge = new Map<string, number>();
  if (pairs?.counters != null) {
    const cap = SCORING_PARAMS.COUNTER_CAP;
    for (const [key, count] of Object.entries(pairs.counters)) {
      const [x, y] = key.split("|");
      const rateX = heroRate.get(x);
      const rateY = heroRate.get(y);
      if (rateX == null || rateY == null) continue;
      const expected = Math.min(
        0.95,
        Math.max(0.05, pBar + (rateX - pBar) - (rateY - pBar)),
      );
      const observed = shrunk(
        count.wins,
        count.matches,
        expected,
        SCORING_PARAMS.M_COUNTER,
      );
      const edge = Math.min(
        cap,
        Math.max(-cap, logit(observed) - logit(expected)),
      );
      if (edge !== 0) counterEdge.set(key, edge);
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
    teamUpsByHero,
    banRate,
    shapeDelta,
    metaThreats,
    pairSynergy,
    counterEdge,
    heroRate,
    personalDelta: new Map(),
    temperature,
    strengthSamples,
    pickShare,
    fieldShare,
    fieldMatchup,
  };
}

export interface PersonalHeroRecord {
  id: string;
  games: number;
  wins: number;
}

/**
 * Overlay a player's own per-hero record onto the tables. Returns a new
 * tables object (the scorer's context caches key off identity, so the
 * shared band tables stay unpolluted).
 */
export function withPersonal(
  tables: ScoringTables,
  records: readonly PersonalHeroRecord[],
): ScoringTables {
  const personalDelta = new Map<string, number>();
  const cap = SCORING_PARAMS.PERSONAL_CAP;
  for (const r of records) {
    if (r.games <= 0 || !tables.heroes.has(r.id)) continue;
    const base = tables.heroRate.get(r.id) ?? tables.pBar;
    const observed = shrunk(r.wins, r.games, base, SCORING_PARAMS.M_PERSONAL);
    const delta = Math.min(cap, Math.max(-cap, logit(observed) - logit(base)));
    if (delta !== 0) personalDelta.set(r.id, delta);
  }
  return { ...tables, personalDelta };
}
