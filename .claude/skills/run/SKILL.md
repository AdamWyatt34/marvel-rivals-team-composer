---
name: run
description: Build, test, and run THIS repository using its recorded commands. Use when building, testing, or launching the project so the agent follows the known-good recipe instead of rediscovering it.
---

# Run / Verify — marvel-rivals-team-composer

Recorded build/test/run recipe for this repo. Follow these commands; don't improvise.
All commands run from `src/web` (the only package). Node 22, npm.

## Build

```
cd src/web && npm run build
```

Static export to `src/web/out/`. `NEXT_PUBLIC_BASE_PATH` is unset locally;
CI sets it to `/marvel-rivals-team-composer`.

## Test

```
cd src/web && npm run test
```

vitest, ~2 s, 7 files / 78 tests: engine (`lib/engine/__tests__`), ingest
(`scripts/ingest/__tests__`), backtest (`scripts/backtest/__tests__`).
`lib/engine/__tests__/integration.test.ts` runs the full compose flow over
the real committed snapshot with a 4000 ms smoke bound.

## Run

```
cd src/web && npm run dev
```

http://localhost:3000 (Turbopack). Data comes from `public/data/*.json`.

## Notes

- **Verify = `npm run test` then `npm run build`.** Both are the PR gates.
  `npm run lint` (eslint) exists but is not a CI gate.
- First run: `npm ci` in `src/web`.
- `npm run bench` (`scripts/bench.mts`) times the engine — use it for perf
  work instead of eyeballing the integration test's elapsed time.
- Data scripts (`ingest`, `sample-pairs`, `backtest`, `build-trends`,
  `build-reference`) hit rivalsmeta.com and rewrite `data/` /
  `public/data/`; they are the Actions workflows' job, not part of verify.
