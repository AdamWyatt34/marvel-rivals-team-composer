//! wasm-bindgen surface over the scorer and beam composer. The TypeScript bridge
//! (`lib/engine/wasm-bridge.ts`) owns id <-> index translation and probability
//! calibration; this side only ever sees hero indices and returns log-odds.

pub mod compose;
pub mod scorer;
pub mod tables;

use wasm_bindgen::prelude::*;

use compose::{ComposeError, Rules};
use scorer::ScoreContext;
use tables::Tables;

/// The bridge only ever sends roster indices, but a stray one would index past
/// the tables and trap the instance; an error keeps the fallback graceful.
fn check_indices(n: usize, arrays: &[&[u32]]) -> Result<(), JsError> {
    match arrays
        .iter()
        .flat_map(|a| a.iter())
        .find(|&&h| h as usize >= n)
    {
        Some(h) => Err(JsError::new(&format!("hero index {} out of range", h))),
        None => Ok(()),
    }
}

fn map_arg(map_index: i32, map_given: bool) -> (Option<usize>, bool) {
    let map = if map_given && map_index >= 0 {
        Some(map_index as usize)
    } else {
        None
    };
    (map, map_given)
}

#[wasm_bindgen]
pub struct WasmTables {
    inner: Tables,
}

#[wasm_bindgen]
impl WasmTables {
    #[wasm_bindgen(constructor)]
    pub fn new(u32s: &[u32], f64s: &[f64]) -> Result<WasmTables, JsError> {
        Tables::from_blobs(u32s, f64s)
            .map(|inner| WasmTables { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// `map_index` is ignored unless `map_given`; a given-but-unknown map (index -1)
    /// still counts as a map for the map term, which is then exactly zero, as in TypeScript.
    pub fn score_z(
        &self,
        ours: &[u32],
        enemy: &[u32],
        banned: &[u32],
        map_index: i32,
        map_given: bool,
    ) -> Result<f64, JsError> {
        check_indices(self.inner.n, &[ours, enemy, banned])?;
        let (map, map_given) = map_arg(map_index, map_given);
        let ctx = ScoreContext::new(&self.inner, enemy, map, map_given, banned);
        Ok(scorer::z_of(&self.inner, &ctx, ours))
    }

    /// Returns `[z, hero index...]`; the bridge maps indices back to heroes and derives
    /// the probability. Errors carry the TypeScript engine's names so the bridge can
    /// rethrow the same types.
    #[allow(clippy::too_many_arguments)]
    pub fn compose(
        &self,
        locked: &[u32],
        enemy: &[u32],
        banned: &[u32],
        pool: &[u32],
        has_pool: bool,
        map_index: i32,
        map_given: bool,
        min_strategists: u32,
        min_vanguards: u32,
        min_duelists: u32,
        team_size: u32,
        beam_width: u32,
    ) -> Result<Vec<f64>, JsError> {
        // locked is left to compose, whose UnknownLock error names the hero
        check_indices(self.inner.n, &[enemy, banned, pool])?;
        let (map, map_given) = map_arg(map_index, map_given);
        let rules = Rules {
            min_strategists: min_strategists as usize,
            min_vanguards: min_vanguards as usize,
            min_duelists: min_duelists as usize,
            team_size: team_size as usize,
        };
        let pool_filter = if has_pool { Some(pool) } else { None };
        match compose::compose(
            &self.inner,
            locked,
            enemy,
            banned,
            pool_filter,
            map,
            map_given,
            &rules,
            beam_width as usize,
        ) {
            Ok(c) => {
                let mut out = Vec::with_capacity(c.team.len() + 1);
                out.push(c.z);
                out.extend(c.team.iter().map(|&h| h as f64));
                Ok(out)
            }
            Err(ComposeError::NoFeasibleTeam) => Err(JsError::new("NoFeasibleTeamError")),
            Err(ComposeError::UnknownLock(h)) => {
                Err(JsError::new(&format!("Unknown locked hero id: {}", h)))
            }
        }
    }
}
