//! Port of the beam search in `lib/engine/compose.ts`. The pool walks heroes in table
//! order, role-needed candidates first, beams are deduped by hero set, the sort is
//! stable, and ties resolve to the first maximum — every one of those is what makes
//! the chosen team identical to the TypeScript engine's, not just equally good.

use crate::scorer::{z_of, ScoreContext};
use crate::tables::{Tables, ROLE_DUELIST, ROLE_STRATEGIST, ROLE_VANGUARD};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub min_strategists: usize,
    pub min_vanguards: usize,
    pub min_duelists: usize,
    pub team_size: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ComposeError {
    UnknownLock(u32),
    NoFeasibleTeam,
}

#[derive(Debug)]
pub struct Composed {
    pub team: Vec<u32>,
    pub z: f64,
}

struct Beam {
    team: Vec<u32>,
    mask: u128,
    z: f64,
}

struct Needs {
    strategists: usize,
    vanguards: usize,
    duelists: usize,
}

fn role_counts(tables: &Tables, team: &[u32]) -> [usize; 3] {
    let mut counts = [0usize; 3];
    for &h in team {
        counts[tables.roles[h as usize] as usize] += 1;
    }
    counts
}

fn unmet_needs(tables: &Tables, team: &[u32], rules: &Rules) -> Needs {
    let counts = role_counts(tables, team);
    Needs {
        strategists: rules
            .min_strategists
            .saturating_sub(counts[ROLE_STRATEGIST as usize]),
        vanguards: rules
            .min_vanguards
            .saturating_sub(counts[ROLE_VANGUARD as usize]),
        duelists: rules
            .min_duelists
            .saturating_sub(counts[ROLE_DUELIST as usize]),
    }
}

pub fn meets_hard_rules(tables: &Tables, team: &[u32], rules: &Rules) -> bool {
    let counts = role_counts(tables, team);
    counts[ROLE_STRATEGIST as usize] >= rules.min_strategists
        && counts[ROLE_VANGUARD as usize] >= rules.min_vanguards
        && counts[ROLE_DUELIST as usize] >= rules.min_duelists
        && team.len() == rules.team_size
}

fn still_feasible(
    tables: &Tables,
    team: &[u32],
    mask: u128,
    rules: &Rules,
    pool: &[u32],
    slots_left: usize,
) -> bool {
    let need = unmet_needs(tables, team, rules);
    let mut avail = [0usize; 3];
    for &h in pool {
        if mask & (1u128 << h) == 0 {
            avail[tables.roles[h as usize] as usize] += 1;
        }
    }
    need.strategists <= avail[ROLE_STRATEGIST as usize]
        && need.vanguards <= avail[ROLE_VANGUARD as usize]
        && need.duelists <= avail[ROLE_DUELIST as usize]
        && slots_left >= need.strategists + need.vanguards + need.duelists
}

#[allow(clippy::too_many_arguments)]
pub fn compose(
    tables: &Tables,
    locked: &[u32],
    enemy: &[u32],
    banned: &[u32],
    pool_filter: Option<&[u32]>,
    map: Option<usize>,
    map_given: bool,
    rules: &Rules,
    beam_width: usize,
) -> Result<Composed, ComposeError> {
    let n = tables.n as u32;
    if let Some(&bad) = locked.iter().find(|&&h| h >= n) {
        return Err(ComposeError::UnknownLock(bad));
    }
    let banned_mask = crate::tables::hero_mask(banned);
    let locked_mask = crate::tables::hero_mask(locked);
    let allowed_mask = pool_filter.map(crate::tables::hero_mask);
    let pool: Vec<u32> = (0..n)
        .filter(|&h| {
            let bit = 1u128 << h;
            banned_mask & bit == 0
                && locked_mask & bit == 0
                && allowed_mask.is_none_or(|m| m & bit != 0)
        })
        .collect();

    let ctx = ScoreContext::new(tables, enemy, map, map_given, banned);
    let mut beams = vec![Beam {
        team: locked.to_vec(),
        mask: locked_mask,
        z: z_of(tables, &ctx, locked),
    }];
    let mut completed: Vec<Beam> = Vec::new();

    while !beams.is_empty() && beams[0].team.len() < rules.team_size {
        let mut next: Vec<Beam> = Vec::new();
        let mut seen: std::collections::HashSet<u128> = std::collections::HashSet::new();

        for beam in &beams {
            let slots_left = rules.team_size - beam.team.len();
            if !still_feasible(tables, &beam.team, beam.mask, rules, &pool, slots_left) {
                continue;
            }
            let need = unmet_needs(tables, &beam.team, rules);
            let candidates: Vec<u32> = pool
                .iter()
                .copied()
                .filter(|&h| beam.mask & (1u128 << h) == 0)
                .collect();
            let needed = |h: u32| {
                let role = tables.roles[h as usize];
                (need.strategists > 0 && role == ROLE_STRATEGIST)
                    || (need.vanguards > 0 && role == ROLE_VANGUARD)
                    || (need.duelists > 0 && role == ROLE_DUELIST)
            };
            let ordered = candidates
                .iter()
                .copied()
                .filter(|&h| needed(h))
                .chain(candidates.iter().copied().filter(|&h| !needed(h)));

            for hero in ordered {
                let mut team = Vec::with_capacity(beam.team.len() + 1);
                team.extend_from_slice(&beam.team);
                team.push(hero);
                let mask = beam.mask | (1u128 << hero);
                if team.len() == rules.team_size {
                    if meets_hard_rules(tables, &team, rules) {
                        let z = z_of(tables, &ctx, &team);
                        completed.push(Beam { team, mask, z });
                    }
                    continue;
                }
                if !seen.insert(mask) {
                    continue;
                }
                let z = z_of(tables, &ctx, &team);
                next.push(Beam { team, mask, z });
            }
        }

        if next.is_empty() {
            break;
        }
        next.sort_by(|a, b| b.z.partial_cmp(&a.z).expect("z is never NaN"));
        next.truncate(beam_width);
        beams = next;
    }

    let finals = if completed.is_empty() { beams } else { completed };
    let mut best: Option<&Beam> = None;
    for beam in &finals {
        if !meets_hard_rules(tables, &beam.team, rules) {
            continue;
        }
        match best {
            Some(b) if beam.z > b.z => best = Some(beam),
            Some(_) => {}
            None => best = Some(beam),
        }
    }
    let best = best.ok_or(ComposeError::NoFeasibleTeam)?;
    Ok(Composed {
        team: best.team.clone(),
        z: best.z,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::fixture::*;

    // fixture roles: hero i has role i % 3 -> Vanguard {0,3,6}, Duelist {1,4,7}, Strategist {2,5}
    const RULES: Rules = Rules {
        min_strategists: 2,
        min_vanguards: 1,
        min_duelists: 1,
        team_size: 6,
    };

    fn run(
        tables: &Tables,
        locked: &[u32],
        banned: &[u32],
        rules: &Rules,
        width: usize,
    ) -> Result<Composed, ComposeError> {
        compose(tables, locked, &[], banned, None, None, false, rules, width)
    }

    #[test]
    fn infeasible_minimums_are_reported() {
        let t = tables();
        // both strategists banned: min_strategists 2 cannot be met
        assert_eq!(
            run(&t, &[], &[2, 5], &RULES, 32).unwrap_err(),
            ComposeError::NoFeasibleTeam
        );
    }

    #[test]
    fn an_unknown_lock_is_reported() {
        let t = tables();
        assert_eq!(
            run(&t, &[42], &[], &RULES, 32).unwrap_err(),
            ComposeError::UnknownLock(42)
        );
    }

    #[test]
    fn picks_a_full_team_that_meets_the_rules() {
        let t = tables();
        let c = run(&t, &[0], &[], &RULES, 32).unwrap();
        assert_eq!(c.team.len(), 6);
        assert_eq!(c.team[0], 0);
        assert!(meets_hard_rules(&t, &c.team, &RULES));
        // both strategists are forced; {0,1,2} pays 0.06 and {3,4} 0.02 in log-odds,
        // which beats the 0.0212 the two strongest duelist/vanguard picks would add
        let mut sorted = c.team.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_beam_width_of_one_still_completes() {
        let t = tables();
        let wide = run(&t, &[0], &[], &RULES, 32).unwrap();
        let narrow = run(&t, &[0], &[], &RULES, 1).unwrap();
        assert_eq!(narrow.team.len(), 6);
        assert!(narrow.z <= wide.z);
    }

    #[test]
    fn a_locked_full_team_skips_the_search_and_is_judged_by_the_rules() {
        let t = tables();
        let ok = run(&t, &[0, 1, 2, 3, 4, 5], &[], &RULES, 32).unwrap();
        assert_eq!(ok.team, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(
            run(&t, &[0, 1, 3, 4, 6, 7], &[], &RULES, 32).unwrap_err(),
            ComposeError::NoFeasibleTeam
        );
    }

    #[test]
    fn the_pool_filter_restricts_non_locked_picks() {
        let t = tables();
        let c = compose(&t, &[0], &[], &[], Some(&[2, 5, 1, 3, 4]), None, false, &RULES, 32)
            .unwrap();
        let mut sorted = c.team.clone();
        sorted.sort();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);
        assert!(compose(&t, &[0], &[], &[], Some(&[]), None, false, &RULES, 32).is_err());
    }

    #[test]
    fn equal_scores_keep_the_first_completed_team_in_walk_order() {
        // equal strengths and no team-up bonus: every complete team scores the same, so
        // the winner is the first team completed in walk order (needed roles first)
        let b = blobs_with(|f, _| {
            for i in 0..N {
                f[PARAM_COUNT + i] = 0.01;
            }
            let len = f.len();
            for bonus in &mut f[len - 3..] {
                *bonus = 0.0;
            }
        });
        let t = Tables::from_blobs(&b.u32s, &b.f64s).unwrap();
        let c = run(&t, &[7], &[], &RULES, 32).unwrap();
        assert_eq!(c.team, vec![7, 0, 2, 5, 1, 3]);
    }

    use crate::tables::PARAM_COUNT;
}
