# Marvel Rivals Team Composer

Static Next.js 15 / React 19 / TypeScript app (`src/web`), exported to GitHub
Pages. **No backend** — the scoring engine runs in the browser from a daily
committed snapshot. Charter: `.aios/charter.json`.

## Commands (run from `src/web`)

```powershell
npm ci
npm run dev        # http://localhost:3000
npm run test       # vitest — engine + ingest + backtest suites, ~2 s
npm run build      # next build (static export to out/)
npm run lint       # eslint — not a CI gate
npm run bench      # scripts/bench.mts: engine timing
```

PR gates: `npm run test` and `npm run build` green (both enforced by
`deploy-pages.yml`). See `.claude/skills/run/SKILL.md`.

## Layers — keep them this way

- `lib/data/` — zod schemas + `fetch` loaders for `public/data/*.json`. The
  only runtime code that touches the network.
- `lib/engine/` — **pure and DOM-free.** Imports only data-schema types and
  sibling modules; never `fetch`, `window`, `document`, or React. This is
  what lets it run unchanged in a Web Worker or under `tsx` for the backtest.
- `app/local-api.ts` — the **single seam** between UI and engine. Owns the
  `tablesCache` (per tier band) and `personalCache`. Components call
  `local-api`, never `lib/engine` directly.
- `app/` — UI. `page.tsx` (~820 lines), `HeroGrid.tsx`, `ResultsPanel.tsx`.
- `scripts/{ingest,pairs,backtest,trends}` — tsx CLIs run by the Actions
  workflows; they commit into `data/` and `public/data/`.

## Gotchas

- `data/**` and `public/data/**` are **bot-written** by the three daily
  workflows (`refresh-data`, `sample-matches`, deploy). Hand edits get
  overwritten on the next run; `data/reference/*` is the exception and is
  regenerated with `npm run build-reference -- --live` when a hero ships.
- `SCORING_PARAMS` in `lib/engine/stats.ts` are backtest-tuned. Change them
  via `npm run backtest` output, not by intuition.
- The model is a transparent additive log-odds sum, not ML. Every term must
  stay inspectable — `explain.ts` reports the model's own contributions.
- `integration.test.ts` has a 4000 ms smoke bound on the full compose flow
  (raised from 2 s when season 18 quadrupled team-ups). It is a flakiness
  guard, not an SLO; don't raise it to make a change pass.
- `NEXT_PUBLIC_BASE_PATH` is empty locally and `/marvel-rivals-team-composer`
  on Pages; `lib/data/load.ts` prefixes every data fetch with it.
- RivalsMeta's API is unofficial. Ingest fails safe and keeps the last good
  snapshot; a new hero fails ingest deterministically ("Unmapped RivalsMeta
  hero ids") and the workflow opens a reference-refresh PR.
- Profile import needs the Cloudflare proxy (`infra/rivalsmeta-proxy.js`) and
  the `PROFILE_PROXY_URL` repo variable; the UI is hidden without it.

## Conventions

- Conventional commits: `feat(web)`, `fix(ingest)`, `chore(data)`, etc.
  No Co-Authored-By or AI-attribution trailers.
- PowerShell for anything the human runs; the repo's own scripts are node/tsx.
