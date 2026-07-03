# Marvel Rivals Team Composer

Suggests the ideal 6-hero team comp for **Marvel Rivals** given your locked picks
(e.g. you play Thor, your duo plays Winter Soldier), the enemy's known picks, and
any bans. Runs entirely in the browser from a daily data snapshot — no backend,
hosted for free on GitHub Pages.

- Locked picks (immutable on your side), enemy picks, bans
- Hard role rules: **≥ 2 Strategists, ≥ 1 Vanguard, ≥ 1 Duelist**, team of 6
- Live composition — recommendations update as you click
- Rank-band filtering (All / Gold+ / Platinum+ / Diamond+ / Grandmaster+)
- Per-map hero deltas, hero-vs-hero matchups, team-up bonuses
- Backups per role, adversarial ban suggestions, rule-based explanations

## How it works

```
marvel-rivals-team-composer/
├─ data/reference/            # slow-moving: hero ids/roles, maps, team-up defs
├─ src/web/
│  ├─ app/                    # Next.js UI (static export)
│  ├─ lib/data/               # snapshot zod schema + loader
│  ├─ lib/engine/             # scoring engine (see below) + beam-search composer
│  ├─ scripts/ingest/         # daily RivalsMeta → snapshot pipeline
│  └─ public/data/snapshot.json  # committed daily by GitHub Actions
└─ .github/workflows/
   ├─ refresh-data.yml        # daily 04:00 UTC: fetch, validate, commit snapshot
   └─ deploy-pages.yml        # on push to master: test, build, deploy to Pages
```

**Data** comes from rivalsmeta.com's (unofficial, undocumented) stats API and
matchup pages: per-rank win/pick/ban counts, per-map win rates, hero-vs-hero
matchup matrix (Diamond+), and team-up stats. The ingest validates everything
(zod schema + sanity gates) and refuses to overwrite the last good snapshot on
failure. Season rollovers are detected automatically by probing the next
season id when data goes stale.

**Scoring** is a transparent additive log-odds model, not ML:

- Hero strength = empirical-Bayes-shrunk win rate delta vs the rank band's mean.
  Niche heroes get a stronger prior (specialist/one-trick bias), and strengths
  are soft-capped (`tanh`) so a 59%-win-rate one-trick hero can't dominate.
- Matchup terms shrink each pair's win rate toward the hero's own baseline.
- Map deltas shrink per-map rates toward the hero's overall rate.
- Team-up bonuses are corrected for member strength and clamped.
- Team score = weighted sum → sigmoid → win probability. Every term is
  inspectable; the "why this lineup" list is the model's own contributions.

The composer is a beam search over the hero pool honoring locks, bans, and role
minimums. Ban suggestions greedily search for the ban that most improves your
best comp vs the enemy's best response.

## Local development

```powershell
cd src/web
npm ci
npm run dev              # UI at http://localhost:3000
npm run test             # vitest: engine + ingest suites
npm run ingest           # refresh public/data/snapshot.json from rivalsmeta.com
npm run build-reference  # regenerate data/reference/* (run when a new hero ships)
```

New hero shipped? `npm run build-reference -- --live`, review the diff in
`data/reference/`, commit, then `npm run ingest`.

## Deployment

Pushes to `master` that touch `src/web/**` deploy to GitHub Pages via
`deploy-pages.yml` (repo Settings → Pages → Source: "GitHub Actions").
The daily `refresh-data.yml` commit triggers a redeploy automatically, so the
site never serves data older than ~24h while the source keeps updating.

## Disclaimer

Not affiliated with NetEase or Marvel. Statistics are sourced from the
community site [rivalsmeta.com](https://rivalsmeta.com); its endpoints are
unofficial and may change without notice — the ingest pipeline fails safely
and keeps the last good snapshot if they do.
