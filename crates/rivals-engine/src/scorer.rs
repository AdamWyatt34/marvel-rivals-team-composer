//! Port of `zOf` in `lib/engine/scorer.ts`. Every accumulation runs in the same order
//! as the TypeScript so the result is bit-identical: floating-point addition is not
//! associative, so "equivalent" reorderings are not.

use crate::tables::{hero_mask, Tables, ROLE_DUELIST, ROLE_STRATEGIST, ROLE_VANGUARD, SHAPE_DIM};

/// Scorer structure, not a tuned parameter: partial teams still divide by the full
/// team size so that a partial team scores below a complete one.
const TEAM_SIZE: f64 = 6.0;
const FULL_TEAM_PAIRS: f64 = TEAM_SIZE * (TEAM_SIZE - 1.0) / 2.0;
const TEAM_SIZE_USIZE: usize = 6;

/// Everything that depends only on (enemy set, map, bans): constant across a whole
/// compose or ban search, so it is built once per call instead of per score.
pub struct ScoreContext {
    pub enemy: Vec<u32>,
    pub map: Option<usize>,
    pub map_given: bool,
    threats: Vec<u32>,
    /// Per hero: matchup sum vs the enemies, field edge, counter sum, map delta.
    cross: Vec<[f64; 4]>,
    /// `threat_rows[h * threats.len() + ti]`.
    threat_rows: Vec<f64>,
    enemy_teamup: f64,
    enemy_pairs: f64,
}

fn ordered_dedup(first: &[u32], second: &[u32]) -> Vec<u32> {
    let mut seen = 0u128;
    let mut out = Vec::with_capacity(first.len() + second.len());
    for &id in first.iter().chain(second.iter()) {
        if seen & (1u128 << id) == 0 {
            seen |= 1u128 << id;
            out.push(id);
        }
    }
    out
}

impl ScoreContext {
    pub fn new(
        tables: &Tables,
        enemy: &[u32],
        map: Option<usize>,
        map_given: bool,
        banned: &[u32],
    ) -> ScoreContext {
        let excluded = ordered_dedup(banned, enemy);
        let banned_mask = hero_mask(banned);

        let mut threats = ordered_dedup(enemy, &[]);
        let mut threat_mask = hero_mask(&threats);
        for &t in &tables.meta_threats {
            if threats.len() >= tables.params.meta_threat_count {
                break;
            }
            if banned_mask & (1u128 << t) != 0 {
                continue;
            }
            if threat_mask & (1u128 << t) == 0 {
                threat_mask |= 1u128 << t;
                threats.push(t);
            }
        }

        let mut cross = Vec::with_capacity(tables.n);
        for h in 0..tables.n as u32 {
            let mut matchup_sum = 0.0;
            let mut counter_sum = 0.0;
            for &e in enemy {
                matchup_sum += tables.matchup_at(h, e);
                counter_sum += tables.counter_at(h, e);
            }
            let field = if tables.has_field {
                field_edge(tables, h, &excluded)
            } else {
                0.0
            };
            let map_delta = match map {
                Some(m) => tables.map_delta_at(h, m),
                None => 0.0,
            };
            cross.push([matchup_sum, field, counter_sum, map_delta]);
        }

        let mut threat_rows = Vec::with_capacity(tables.n * threats.len());
        for h in 0..tables.n as u32 {
            for &t in &threats {
                threat_rows.push(tables.matchup_at(h, t));
            }
        }

        ScoreContext {
            enemy_teamup: teamup_bonus(tables, enemy),
            enemy_pairs: pair_sum(tables, enemy),
            enemy: enemy.to_vec(),
            map,
            map_given,
            threats,
            cross,
            threat_rows,
        }
    }
}

pub fn z_of(tables: &Tables, ctx: &ScoreContext, ours: &[u32]) -> f64 {
    let p = &tables.params;
    let l = ours.len();
    let e = ctx.enemy.len();
    let mut z = p.z_bar;

    let mut strength_sum = 0.0;
    for &h in ours {
        strength_sum += tables.strength[h as usize] + tables.personal[h as usize];
    }
    for &en in &ctx.enemy {
        strength_sum -= tables.strength[en as usize];
    }
    z += (p.k_hero * strength_sum) / TEAM_SIZE;

    if l > 0 {
        let mut matchup_sum = 0.0;
        let mut field_sum = 0.0;
        let mut counter_sum = 0.0;
        let mut map_sum = 0.0;
        for &h in ours {
            let [m, f, c, d] = ctx.cross[h as usize];
            matchup_sum += m;
            field_sum += f;
            counter_sum += c;
            map_sum += d;
        }

        let mut matchup_term = 0.0;
        if e > 0 {
            matchup_term += (e as f64 / TEAM_SIZE) * (matchup_sum / ((l * e) as f64));
        }
        if e < TEAM_SIZE_USIZE && tables.has_field {
            matchup_term += ((TEAM_SIZE - e as f64) / TEAM_SIZE) * (field_sum / l as f64);
        }
        z += p.k_matchup * matchup_term;

        if e > 0 {
            z += p.k_counter * (e as f64 / TEAM_SIZE) * (counter_sum / ((l * e) as f64));
        }

        if ctx.map_given {
            z += (p.k_map * map_sum) / TEAM_SIZE;
        }
    }

    let our_teamup = teamup_bonus(tables, ours);
    z += p.k_teamup * (our_teamup - ctx.enemy_teamup);
    z += p.k_shape * shape_delta(tables, ours).unwrap_or(0.0);
    let our_pairs = pair_sum(tables, ours);
    z += (p.k_pair * (our_pairs - ctx.enemy_pairs)) / FULL_TEAM_PAIRS;

    if l > 0 {
        let mut total_gap = 0.0;
        let mut gaps = 0usize;
        let width = ctx.threats.len();
        for (ti, &threat) in ctx.threats.iter().enumerate() {
            let mut best = f64::NEG_INFINITY;
            for &h in ours {
                if h == threat {
                    best = 0.0;
                    break;
                }
                let edge = ctx.threat_rows[h as usize * width + ti];
                if edge > best {
                    best = edge;
                }
            }
            if best < 0.0 {
                total_gap += best;
                gaps += 1;
            }
        }
        if gaps > 0 {
            z += (p.k_coverage * total_gap) / gaps as f64;
        }
    }

    z
}

/// Expected edge vs an unknown enemy slot with the excluded heroes removed from the
/// field distribution and the remainder renormalized; 0 when exclusions eat the field.
fn field_edge(tables: &Tables, h: u32, excluded: &[u32]) -> f64 {
    let mut edge = tables.field_matchup[h as usize];
    let mut excluded_share = 0.0;
    for &x in excluded {
        let share = tables.field_share[x as usize];
        if share == 0.0 {
            continue;
        }
        excluded_share += share;
        if x != h {
            edge -= share * tables.matchup_at(h, x);
        }
    }
    let remaining = 1.0 - excluded_share;
    if remaining > 0.05 {
        edge / remaining
    } else {
        0.0
    }
}

fn shape_delta(tables: &Tables, ours: &[u32]) -> Option<f64> {
    if ours.len() != TEAM_SIZE_USIZE {
        return None;
    }
    let mut counts = [0usize; 3];
    for &h in ours {
        counts[tables.roles[h as usize] as usize] += 1;
    }
    let (v, d, s) = (
        counts[ROLE_VANGUARD as usize],
        counts[ROLE_DUELIST as usize],
        counts[ROLE_STRATEGIST as usize],
    );
    if v >= SHAPE_DIM || d >= SHAPE_DIM || s >= SHAPE_DIM {
        return None;
    }
    let value = tables.shape[v * SHAPE_DIM * SHAPE_DIM + d * SHAPE_DIM + s];
    if value.is_nan() {
        None
    } else {
        Some(value)
    }
}

/// One team-up per anchor: a hero selects a single team-up per game, so each anchor
/// contributes its best partner-present variant. Candidates run in ascending team-up
/// index and anchors sum in first-seen order, matching the TypeScript `Map` walk.
pub fn teamup_bonus(tables: &Tables, side: &[u32]) -> f64 {
    if side.is_empty() {
        return 0.0;
    }
    let side_mask = hero_mask(side);
    let words = tables.team_ups_by_hero.first().map_or(0, Vec::len);
    let mut candidates = vec![0u64; words];
    for &h in side {
        for (w, bits) in tables.team_ups_by_hero[h as usize].iter().enumerate() {
            candidates[w] |= bits;
        }
    }

    let mut best_by_anchor: Vec<(u32, f64)> = Vec::new();
    for (w, &word) in candidates.iter().enumerate() {
        let mut bits = word;
        while bits != 0 {
            let ti = w * 64 + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let team_up = &tables.team_ups[ti];
            if side_mask & (1u128 << team_up.anchor) == 0 {
                continue;
            }
            let Some(hit) = team_up
                .variants
                .iter()
                .find(|v| v.mask & side_mask == v.mask)
            else {
                continue;
            };
            match best_by_anchor.iter_mut().find(|(a, _)| *a == team_up.anchor) {
                Some(entry) => {
                    if hit.bonus > entry.1 {
                        entry.1 = hit.bonus;
                    }
                }
                None => best_by_anchor.push((team_up.anchor, hit.bonus)),
            }
        }
    }

    let mut total = 0.0;
    for (_, bonus) in &best_by_anchor {
        total += bonus;
    }
    total
}

/// Pairs are summed in slug order (the order `sideTotals` sorts its cache key), i < j.
pub fn pair_sum(tables: &Tables, side: &[u32]) -> f64 {
    if !tables.has_pair || side.len() < 2 {
        return 0.0;
    }
    let mut sorted = side.to_vec();
    sorted.sort_by_key(|&h| tables.slug_rank[h as usize]);
    let mut sum = 0.0;
    for i in 0..sorted.len() {
        for j in (i + 1)..sorted.len() {
            sum += tables.pair_at(sorted[i], sorted[j]);
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::fixture::*;

    fn ctx(tables: &Tables, enemy: &[u32], banned: &[u32]) -> ScoreContext {
        ScoreContext::new(tables, enemy, None, false, banned)
    }

    #[test]
    fn empty_sides_score_the_base_rate() {
        let t = tables();
        let c = ctx(&t, &[], &[]);
        assert_eq!(z_of(&t, &c, &[]), t.params.z_bar);
    }

    #[test]
    fn a_lone_hero_contributes_its_strength_over_the_team_size() {
        let t = tables();
        let c = ctx(&t, &[], &[]);
        // field_matchup is 0 in the fixture, so the matchup term is exactly 0
        let expected = t.params.z_bar + (t.params.k_hero * t.strength[3]) / TEAM_SIZE;
        assert_eq!(z_of(&t, &c, &[3]), expected);
    }

    #[test]
    fn an_empty_team_against_enemies_only_subtracts_their_side() {
        let t = tables();
        let c = ctx(&t, &[3, 4], &[]);
        let mut strength_sum = 0.0;
        strength_sum -= t.strength[3];
        strength_sum -= t.strength[4];
        let expected = t.params.z_bar + (t.params.k_hero * strength_sum) / TEAM_SIZE
            + t.params.k_teamup * (0.0 - 0.05);
        assert_eq!(z_of(&t, &c, &[]), expected);
    }

    #[test]
    fn threats_cap_at_the_configured_count_and_skip_bans() {
        let t = tables();
        let c = ctx(&t, &[1], &[5]);
        assert_eq!(c.threats, vec![1, 6, 7]);
        let c = ctx(&t, &[6, 6, 1], &[]);
        assert_eq!(c.enemy, vec![6, 6, 1]);
        assert_eq!(c.threats, vec![6, 1, 5]);
    }

    #[test]
    fn field_edge_is_zero_when_exclusions_eat_the_field() {
        let t = tables();
        assert_eq!(field_edge(&t, 0, &[1, 2, 3, 4, 5, 6, 7, 0]), 0.0);
        let b = blobs_with(|f, off| f[off + 0 * N + 1] = 0.2);
        let t = Tables::from_blobs(&b.u32s, &b.f64s).unwrap();
        // fieldMatchup 0, share 1/8 excluded for hero 1: edge = -(1/8 * 0.2) / (7/8)
        let expected = (0.0 - (1.0 / 8.0) * 0.2) / (1.0 - 1.0 / 8.0);
        assert_eq!(field_edge(&t, 0, &[1]), expected);
    }

    #[test]
    fn a_mirror_hero_leaves_no_coverage_gap() {
        let b = blobs_with(|f, off| {
            for h in 0..N {
                f[off + h * N + 5] = -0.3;
            }
        });
        let t = Tables::from_blobs(&b.u32s, &b.f64s).unwrap();
        let c = ctx(&t, &[5], &[]);
        let with_mirror = z_of(&t, &c, &[5, 1]);
        let without = z_of(&t, &c, &[2, 1]);
        // hero 5 answers threat 5 itself; heroes 2 and 1 both sit at -0.3 into it
        assert!(without < with_mirror);
    }

    #[test]
    fn teamups_take_the_biggest_present_variant_per_anchor() {
        let t = tables();
        assert_eq!(teamup_bonus(&t, &[0, 1]), 0.1);
        assert_eq!(teamup_bonus(&t, &[0, 1, 2]), 0.15);
        assert_eq!(teamup_bonus(&t, &[1, 2]), 0.0);
        assert_eq!(teamup_bonus(&t, &[3, 4, 0, 1]), 0.1 + 0.05);
    }

    #[test]
    fn pairs_sum_in_slug_order_regardless_of_team_order() {
        let b = blobs_with(|f, _| {
            let pair_off = PARAM_COUNT + 4 * N + 2 * N * N;
            f[pair_off + 0 * N + 1] = 0.1;
            f[pair_off + 1 * N + 0] = 0.1;
            f[pair_off + 1 * N + 2] = 0.2;
            f[pair_off + 2 * N + 1] = 0.2;
        });
        let t = Tables::from_blobs(&b.u32s, &b.f64s).unwrap();
        assert_eq!(pair_sum(&t, &[2, 0, 1]), pair_sum(&t, &[0, 1, 2]));
        assert_eq!(pair_sum(&t, &[0, 1, 2]), 0.1 + 0.2);
    }

    use crate::tables::PARAM_COUNT;
}
