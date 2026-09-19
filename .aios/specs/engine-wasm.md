# engine-wasm — Step B: port scorer + beam compose to Rust/WASM

Read CLAUDE.md, .aios/charter.json, and the Step A record:
- .aios/tasks/spec-compose-worker/handoff.md (measurements + profile)
- .aios/tasks/spec-compose-worker/plan-challenge.md
- ADR "Run the Marvel Rivals compose flow in a Web Worker with terminate-and-respawn
  cancellation" (aios-decisions, 2026-09-19) and the FFXIV precedent ADR "Ship the
  crafting engine and solvers to the browser as a committed wasm-pack artifact"
  (2026-09-12) — same shape, same CI pattern.
Then the engine and worker files: src/web/lib/engine/{scorer,compose,bans,stats,types}.ts,
src/web/app/{compose-job,compose-worker,compose.worker,compose-client,compose-protocol}.ts,
and the tests under src/web/lib/engine/__tests__/ and src/web/app/__tests__/.

## Where Step A left it

Step A put compose + backups + bans + explain in a Web Worker (PR #9). Compose is
NOT the problem: 31 ms cold / 18 ms warm on desktop, 115–213 ms on a 4x-throttled
main thread. The ban search is: 771 ms desktop, 5.3–5.6 s at 4x. Profile of one
suggestBans call (CDP sampling, main-thread direct path):
- scoreTeam → zOf (scorer.ts:46, :106) = 83% of the ban search
- inside zOf: sideTotals (scorer.ts:367) 31%, crossTerms (:70) 22%, coverageGaps (:242) 17%,
  teamUpBonus (:311) 9%, pairSynergySum (:25) 7%, threatEdgeRow (:298) ~7%
- compose's own beam bookkeeping (compose.ts:39–78): 14% self
- structural multiplier: suggestBans (bans.ts) runs ~90 full beam searches
  (2 + 2×TOP_N(14) candidates per step × k=3 steps), each calling scoreTeam thousands
  of times; scorer.ts memoises per-tables context in three WeakMaps
  (crossCache, threatCache, sideTotalsCache) keyed on the tables object.
The team-up membership-mask idea from July is refuted (9%). backups (2 ms) and
explain (<1 ms) stay in TypeScript.

## Goal

Port scorer.ts (scoreTeam/zOf and every helper above) and compose.ts (beam search
with feasibility pruning and dedupe) to a Rust crate `crates/rivals-engine`, compiled
with wasm-bindgen, running inside the existing worker (and callable on the main-thread
direct path — see Measure). bans.ts stays TypeScript orchestration calling the WASM
compose/scoreTeam ~90 times per search — unless the plan shows the boundary crossings
dominate, in which case port suggestBans too and say why. TypeScript keeps tables,
caches, the compose-client/protocol, the API surface, backups and explain.

Success criterion: bans < 1 s on the 4x-throttled main-thread measurement (Step A's
method), compose still < 1 s, results identical.

## Constraints

- Data crosses the boundary once per `band|personal` key, on the worker's existing
  `{type:"tables"}` message: flatten ScoringTables into typed arrays (hero index
  order, role masks, strength/strengthSamples, the matchup matrix, pair-synergy and
  counter matrices, map deltas, team-up table with variants/members, banRate,
  metaThreats, role-shape prior, pBar/temperature/zBar) — enumerate every field
  scorer.ts and compose.ts read and design the layout in the plan. Per-call inputs
  (locks, enemy, bans, pool, map) are small index arrays. The per-tables context the
  WeakMaps cache today (side totals, cross terms, threat context) is computed once at
  table load in Rust — that is where most of the win is.
- SCORING_PARAMS and calibration have one source of truth: passed from stats.ts at
  init, never duplicated as Rust constants.
- Beam width, role minimums, hero iteration order (TS Map insertion order — pass the
  index order explicitly), sort stability and every tie-break must match the TS
  engine. Discrete outputs (team, order, backups, ban list) must be exactly equal;
  z/prob bit-identical if the plan can guarantee operation order and libm parity
  (exp/tanh), else state the tolerance (≤1e-9) and why.
- Parity oracle: a new engine-level test, TS compose/scoreTeam/suggestBans vs WASM on
  the same inputs over the real snapshot — the Step A smoke inputs (thor +
  winter-soldier vs hela + luna-snow, ban phoenix, map 1291, band all) plus every
  band, several maps, a personal overlay (withPersonal), and a poolIds restriction.
  Step A's app/__tests__/compose-worker.test.ts (direct vs worker handler) keeps
  running unchanged and must stay green; the 4000 ms smoke bound is untouched.
- Fallback: if the .wasm fails to load or instantiate, the worker uses the TS engine
  for the session and says so once in the dev-only log line.
- Build: GitHub Actions already runs test + build in deploy-pages.yml. Propose one of
  (a) commit the wasm-pack output under src/web/ with `npm run wasm:build` through a
  pinned npx wasm-pack, a drift check in CI, and a rust-ci workflow — the FFXIV
  pattern, so `npm run dev`, vitest and the parity test need no Rust toolchain — or
  (b) build in CI and upload the .wasm as a Pages artifact, which makes local dev
  depend on the toolchain. Say which and why.

## Process

- Save this as .aios/specs/engine-wasm.md and run it through /deliver (the repo is
  onboarded; Step A used the same path). Plan first, wait for approval.
- Commits: feat(engine-rs): scorer; feat(engine-rs): beam compose; build(ci): wasm
  build; test(engine): wasm parity. No Co-Authored-By trailers.
- Measure the way Step A did, because Chrome's CPU throttle only slows the renderer
  main thread and never reaches dedicated workers: Playwright + CDP
  Emulation.setCPUThrottlingRate(4) with `Worker` removed by an init script so the
  direct path runs on the main thread; read long-task durations. Report worker
  numbers unthrottled as well.
- Final message: parity result (which cases, exact vs tolerance), and Step A's table
  with a third column:

  | Path | CPU | compose TS | bans TS | compose WASM | bans WASM |
  | worker, desktop | 1x | 31/18 ms | 771 ms | | |
  | main thread direct | 1x | 53 ms | 1246 ms | | |
  | main thread direct (phone proxy) | 4x | 115–213 ms | 5.3–5.6 s | | |

  Decision point: is bans under 1 s at 4x? If not, name what still dominates from a
  fresh profile of the WASM path.
