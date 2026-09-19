//! The scoring tables as the TypeScript side flattens them (`lib/engine/wasm-bridge.ts`
//! `flattenTables`). Two blobs: a `u32` blob with the shape, roles, threats and the
//! team-up CSR, and an `f64` blob with the parameters and every numeric table, dense
//! over hero indices. Hero index = insertion order of `ScoringTables.heroes`, which is
//! also the pool iteration order the beam search must reproduce.

pub const LAYOUT_VERSION: u32 = 1;
/// Hero sets are `u128` bitmasks; the flattener's roster is 56 today.
pub const MAX_HEROES: usize = 128;
/// Role-shape prior is indexed `v*49 + d*7 + s`; counts never exceed the team size.
pub const SHAPE_DIM: usize = 7;

pub const ROLE_VANGUARD: u8 = 0;
pub const ROLE_DUELIST: u8 = 1;
pub const ROLE_STRATEGIST: u8 = 2;

/// `SCORING_PARAMS` values in `PARAM_ORDER`, plus the tables' calibration scalars.
/// Never defaulted here: the TypeScript side is the single source of truth.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub k_hero: f64,
    pub k_matchup: f64,
    pub k_map: f64,
    pub k_teamup: f64,
    pub k_shape: f64,
    pub k_coverage: f64,
    pub k_pair: f64,
    pub k_counter: f64,
    pub meta_threat_count: usize,
    pub p_bar: f64,
    pub z_bar: f64,
    pub temperature: f64,
}

pub const PARAM_COUNT: usize = 12;

#[derive(Clone, Debug)]
pub struct Variant {
    pub members: Vec<u32>,
    pub mask: u128,
    pub bonus: f64,
}

#[derive(Clone, Debug)]
pub struct TeamUp {
    pub anchor: u32,
    /// Most-members-first, as `stats.ts` sorts them; the first subset match wins.
    pub variants: Vec<Variant>,
}

#[derive(Clone, Debug)]
pub struct Tables {
    pub n: usize,
    pub m: usize,
    pub params: Params,
    pub roles: Vec<u8>,
    /// Rank of each hero in ascending slug order; pair synergies are summed in this order.
    pub slug_rank: Vec<u32>,
    pub meta_threats: Vec<u32>,
    pub has_field: bool,
    pub has_pair: bool,
    pub strength: Vec<f64>,
    pub personal: Vec<f64>,
    pub ban_rate: Vec<f64>,
    pub strength_samples: Vec<f64>,
    /// `matchup[h * n + e]`: h's log-odds edge when e is on the enemy team.
    pub matchup: Vec<f64>,
    pub counter: Vec<f64>,
    /// Symmetric; the diagonal is zero.
    pub pair: Vec<f64>,
    /// `map_delta[h * m + map]`.
    pub map_delta: Vec<f64>,
    pub field_share: Vec<f64>,
    pub field_matchup: Vec<f64>,
    /// `NaN` marks a shape the band never recorded (TypeScript's `?? null`).
    pub shape: Vec<f64>,
    pub team_ups: Vec<TeamUp>,
    /// Per hero, a bitset over team-up indices the hero is a member of.
    pub team_ups_by_hero: Vec<Vec<u64>>,
}

struct Cursor<'a, T: Copy> {
    data: &'a [T],
    pos: usize,
    name: &'static str,
}

impl<'a, T: Copy> Cursor<'a, T> {
    fn new(data: &'a [T], name: &'static str) -> Self {
        Cursor { data, pos: 0, name }
    }

    fn take(&mut self, len: usize) -> Result<&'a [T], String> {
        let end = self.pos + len;
        if end > self.data.len() {
            return Err(format!(
                "{} blob too short: wanted {} at {}, have {}",
                self.name,
                len,
                self.pos,
                self.data.len()
            ));
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn one(&mut self) -> Result<T, String> {
        Ok(self.take(1)?[0])
    }

    fn finish(&self) -> Result<(), String> {
        if self.pos != self.data.len() {
            return Err(format!(
                "{} blob has {} trailing values",
                self.name,
                self.data.len() - self.pos
            ));
        }
        Ok(())
    }
}

pub fn hero_mask(ids: &[u32]) -> u128 {
    ids.iter().fold(0u128, |mask, &id| mask | (1u128 << id))
}

impl Tables {
    pub fn from_blobs(u32s: &[u32], f64s: &[f64]) -> Result<Tables, String> {
        let mut u = Cursor::new(u32s, "u32");
        let version = u.one()?;
        if version != LAYOUT_VERSION {
            return Err(format!(
                "layout version {} is not {}",
                version, LAYOUT_VERSION
            ));
        }
        let n = u.one()? as usize;
        let m = u.one()? as usize;
        let t = u.one()? as usize;
        let v = u.one()? as usize;
        let s = u.one()? as usize;
        let k = u.one()? as usize;
        let has_field = u.one()? != 0;
        let has_pair = u.one()? != 0;
        if n > MAX_HEROES {
            return Err(format!("{} heroes exceed the {}-hero mask", n, MAX_HEROES));
        }

        let roles = u.take(n)?.iter().map(|&r| r as u8).collect::<Vec<_>>();
        if roles.iter().any(|&r| r > ROLE_STRATEGIST) {
            return Err("unknown role code".to_string());
        }
        let slug_rank = u.take(n)?.to_vec();
        let meta_threats = u.take(k)?.to_vec();
        let anchors = u.take(t)?.to_vec();
        let variant_start = u.take(t + 1)?.to_vec();
        let member_start = u.take(v + 1)?.to_vec();
        let members = u.take(s)?.to_vec();
        u.finish()?;

        let mut f = Cursor::new(f64s, "f64");
        let p = f.take(PARAM_COUNT)?;
        let params = Params {
            k_hero: p[0],
            k_matchup: p[1],
            k_map: p[2],
            k_teamup: p[3],
            k_shape: p[4],
            k_coverage: p[5],
            k_pair: p[6],
            k_counter: p[7],
            meta_threat_count: p[8] as usize,
            p_bar: p[9],
            z_bar: p[10],
            temperature: p[11],
        };
        let strength = f.take(n)?.to_vec();
        let personal = f.take(n)?.to_vec();
        let ban_rate = f.take(n)?.to_vec();
        let strength_samples = f.take(n)?.to_vec();
        let matchup = f.take(n * n)?.to_vec();
        let counter = f.take(n * n)?.to_vec();
        let pair = f.take(n * n)?.to_vec();
        let map_delta = f.take(n * m)?.to_vec();
        let field_share = f.take(n)?.to_vec();
        let field_matchup = f.take(n)?.to_vec();
        let shape = f.take(SHAPE_DIM * SHAPE_DIM * SHAPE_DIM)?.to_vec();
        let variant_bonus = f.take(v)?.to_vec();
        f.finish()?;

        let in_range = |id: u32| (id as usize) < n;
        if !meta_threats.iter().copied().all(in_range)
            || !anchors.iter().copied().all(in_range)
            || !members.iter().copied().all(in_range)
        {
            return Err("hero index out of range".to_string());
        }
        if variant_start.first() != Some(&0)
            || variant_start.last() != Some(&(v as u32))
            || member_start.first() != Some(&0)
            || member_start.last() != Some(&(s as u32))
        {
            return Err("team-up CSR offsets are inconsistent".to_string());
        }

        let mut team_ups = Vec::with_capacity(t);
        for ti in 0..t {
            let (vs, ve) = (variant_start[ti] as usize, variant_start[ti + 1] as usize);
            if vs > ve || ve > v {
                return Err("team-up variant offsets are inconsistent".to_string());
            }
            let mut variants = Vec::with_capacity(ve - vs);
            for vi in vs..ve {
                let (ms, me) = (member_start[vi] as usize, member_start[vi + 1] as usize);
                if ms > me || me > s {
                    return Err("variant member offsets are inconsistent".to_string());
                }
                let member_ids = members[ms..me].to_vec();
                variants.push(Variant {
                    mask: hero_mask(&member_ids),
                    members: member_ids,
                    bonus: variant_bonus[vi],
                });
            }
            team_ups.push(TeamUp {
                anchor: anchors[ti],
                variants,
            });
        }

        let words = t.div_ceil(64);
        let mut team_ups_by_hero = vec![vec![0u64; words]; n];
        for (ti, team_up) in team_ups.iter().enumerate() {
            for variant in &team_up.variants {
                for &member in &variant.members {
                    team_ups_by_hero[member as usize][ti / 64] |= 1u64 << (ti % 64);
                }
            }
        }

        Ok(Tables {
            n,
            m,
            params,
            roles,
            slug_rank,
            meta_threats,
            has_field,
            has_pair,
            strength,
            personal,
            ban_rate,
            strength_samples,
            matchup,
            counter,
            pair,
            map_delta,
            field_share,
            field_matchup,
            shape,
            team_ups,
            team_ups_by_hero,
        })
    }

    #[inline]
    pub fn matchup_at(&self, h: u32, e: u32) -> f64 {
        self.matchup[h as usize * self.n + e as usize]
    }

    #[inline]
    pub fn counter_at(&self, h: u32, e: u32) -> f64 {
        self.counter[h as usize * self.n + e as usize]
    }

    #[inline]
    pub fn pair_at(&self, a: u32, b: u32) -> f64 {
        self.pair[a as usize * self.n + b as usize]
    }

    #[inline]
    pub fn map_delta_at(&self, h: u32, map: usize) -> f64 {
        self.map_delta[h as usize * self.m + map]
    }
}

#[cfg(test)]
pub mod fixture {
    //! A synthetic 8-hero roster for host tests. Hero i has role i % 3, strength
    //! (i+1)/100, and two team-ups: {0,1} anchored at 0 (bonus 0.1, plus a 3-member
    //! variant {0,1,2} at 0.15) and {3,4} anchored at 4 (bonus 0.05).

    use super::*;

    pub const N: usize = 8;
    pub const M: usize = 2;

    pub fn params() -> [f64; PARAM_COUNT] {
        [0.85, 0.8, 0.5, 0.4, 0.5, 0.6, 0.6, 0.3, 3.0, 0.5, 0.0, 1.0]
    }

    pub struct Blobs {
        pub u32s: Vec<u32>,
        pub f64s: Vec<f64>,
    }

    pub fn blobs() -> Blobs {
        blobs_with(|_, _| {})
    }

    /// `tweak` edits the f64 tables after the defaults are laid down; it receives the
    /// blob and the offset of the matchup matrix.
    pub fn blobs_with(tweak: impl Fn(&mut Vec<f64>, usize)) -> Blobs {
        let n = N;
        let mut u32s = vec![LAYOUT_VERSION, n as u32, M as u32, 2, 3, 7, 3, 1, 1];
        u32s.extend((0..n).map(|i| (i % 3) as u32));
        // slugs are "h0".."h7" so slug rank equals index
        u32s.extend((0..n).map(|i| i as u32));
        u32s.extend([5, 6, 7]);
        u32s.extend([0, 4]);
        u32s.extend([0, 2, 3]);
        u32s.extend([0, 3, 5, 7]);
        u32s.extend([0, 1, 2, 0, 1, 3, 4]);

        let mut f64s = params().to_vec();
        f64s.extend((0..n).map(|i| (i as f64 + 1.0) / 100.0));
        f64s.extend(vec![0.0; n]);
        f64s.extend(vec![0.0; n]);
        f64s.extend(vec![1000.0; n]);
        let matchup_offset = f64s.len();
        f64s.extend(vec![0.0; n * n]);
        f64s.extend(vec![0.0; n * n]);
        f64s.extend(vec![0.0; n * n]);
        f64s.extend(vec![0.0; n * M]);
        f64s.extend((0..n).map(|_| 1.0 / n as f64));
        f64s.extend(vec![0.0; n]);
        f64s.extend(vec![f64::NAN; SHAPE_DIM * SHAPE_DIM * SHAPE_DIM]);
        f64s.extend([0.15, 0.1, 0.05]);
        tweak(&mut f64s, matchup_offset);
        Blobs { u32s, f64s }
    }

    pub fn tables() -> Tables {
        let b = blobs();
        Tables::from_blobs(&b.u32s, &b.f64s).expect("fixture parses")
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    #[test]
    fn parses_the_fixture() {
        let t = tables();
        assert_eq!(t.n, N);
        assert_eq!(t.team_ups.len(), 2);
        assert_eq!(t.team_ups[0].variants.len(), 2);
        assert_eq!(t.team_ups[0].variants[0].members, vec![0, 1, 2]);
        assert_eq!(t.team_ups[1].anchor, 4);
        assert_eq!(t.team_ups_by_hero[2], vec![0b01]);
        assert_eq!(t.team_ups_by_hero[3], vec![0b10]);
        assert_eq!(t.team_ups_by_hero[5], vec![0]);
        assert_eq!(t.params.meta_threat_count, 3);
    }

    #[test]
    fn rejects_a_foreign_layout_version() {
        let mut b = blobs();
        b.u32s[0] = 2;
        assert!(Tables::from_blobs(&b.u32s, &b.f64s)
            .unwrap_err()
            .contains("layout version"));
    }

    #[test]
    fn rejects_more_heroes_than_the_mask_holds() {
        let mut b = blobs();
        b.u32s[1] = 129;
        assert!(Tables::from_blobs(&b.u32s, &b.f64s)
            .unwrap_err()
            .contains("129 heroes"));
    }

    #[test]
    fn rejects_trailing_data() {
        let mut b = blobs();
        b.f64s.push(1.0);
        assert!(Tables::from_blobs(&b.u32s, &b.f64s)
            .unwrap_err()
            .contains("trailing"));
    }
}
