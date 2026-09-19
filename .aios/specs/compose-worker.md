# Compose in a Web Worker with cancellation

Read README.md and CLAUDE.md, then:

- src/web/lib/engine/compose.ts, scorer.ts, and everything else under src/web/lib/engine/
- src/web/lib/engine/__tests__/integration.test.ts (note the 4000 ms smoke budget and the comment about season 18 quadrupling team-ups)
- src/web/app/local-api.ts (tablesCache, personalCache)
- the components that call compose/backups/bans/explain (grep for the engine entry points; HeroGrid.tsx is one)

## Goal

Run the full compose flow (compose + backups + ban suggestions + explain) off the main thread in a dedicated Web Worker, so the UI stays interactive on phones during a solve, and add cancellation so a new click aborts the in-flight solve. No Rust in this step.

## Constraints

- Worker protocol as a TypeScript discriminated union; the engine code itself must not import anything DOM-only so it runs unchanged inside the worker. If it does today, that refactor is part of this step and goes in the plan.
- Table loading: the worker must not refetch the ~314 KB snapshot; transfer the parsed tables once (structured clone or transfer) and reuse the WeakMap/LRU caches inside the worker.
- Keep the existing tests green; add a test that the worker path and the direct path return identical results for a fixed set of lock/enemy/ban/map inputs.
- Measure: log compose wall-clock on the worker for the same inputs the smoke test uses, on desktop and on a throttled mobile profile (Chrome devtools 4x CPU). Put the numbers in the final message.

## Process

- Plan first: files touched, the protocol type, the cancellation mechanism. Wait for approval.
- Commits: `refactor(engine): make engine DOM-free`; `feat(web): compose in worker`; `test(engine): worker parity`. No Co-Authored-By trailers.
- Decision point in the final message: with the worker in place, is the compose wall-clock on a 4x-throttled phone under 1 s? If yes, say Step B is unnecessary and stop. If no, list exactly which functions in scorer.ts/compose.ts dominate (use the profiler, not intuition).
