# what the fuck can i eat

A single static page listing the US food recalls and alerts from the past 30
days. Each row is a food name in large plain type, and beside it one factual line
naming the brand, the stores, the states, the country of origin, and the lot codes
to avoid.

It is built for someone standing in a kitchen holding a package, wanting to know
in about four seconds whether the thing in their hand is the thing on the news.
The voice is snarky. The avoid-line is not — those are two different jobs, and
they are generated under two different sets of rules.

## Status

Written end to end, not yet proven in production. The pipeline fetches, merges
and renders live data from all three sources, and 206 tests pass offline against
captured fixtures. What has **never run** is the automation: the daily
refresh workflow and the FSIS reachability probe exist and their YAML parses,
and that is all that is known about them.

⚠️ FSIS reachability is proven from the author's laptop only. `www.fsis.usda.gov`
blocks by TLS fingerprint — that is why [`impit`](https://www.npmjs.com/package/impit)
is a dependency — and a GitHub Actions runner has different egress and different
IP reputation. Until `.github/workflows/fsis-probe.yml` is dispatched, treat meat,
poultry and egg coverage under CI as an open risk. A silent FSIS failure is the
dangerous one: those recalls vanish while the page still looks complete.

## Where the facts come from, and where they don't

**AI writes voice. Government APIs supply facts.** This is not a stylistic
preference. People read this page to decide whether to eat something, and a
hallucinated lot code is not a cosmetic bug.

Brand, company, product, reason and dates come from openFDA's columns or from the
structured `<dl>` block of an FDA press release, and are never model-written.
Everything from FSIS comes from FSIS's own structured fields, likewise. The model
is allowed to *extract* retailers, states, country of origin and lot codes from
press-release prose, and it is allowed to write the headline and the avoid-line.
That is the whole of its remit.

Three constraints hold that line:

- The model is given the text of **one cited government page** and nothing else.
  It never searches the open web, and it is never handed two pages at once, since
  then it could blend them.
- `reason` is stored **verbatim** from the government text. It is never rewritten,
  summarised or cleaned up.
- Every record keeps a `sourceUrl` pointing at the government page it came from.
  A reader who does not believe the page can go and read the source.

Raw API responses are committed under `data/snapshots/`, so when the page is
wrong you can tell whether the government said it or the model invented it.

## Sources

- **openFDA** (`api.fda.gov`) — structured and authoritative, but roughly weekly
  and lagging announcement by weeks.
- **The FDA food-safety recalls RSS feed**, plus the press-release page each item
  points at — fresh, but thin, so the facts are parsed out of the release itself.
- **USDA FSIS** — meat, poultry and eggs, which openFDA does not carry. Fresh
  *and* fully structured.

Every record carries a `confidence`: `verified` when the facts came from
structured government columns (openFDA or FSIS), `extracted` when Gemini read
them out of press-release prose. The page labels the difference rather than
flattening it.

## What's included

Status `Ongoing`, Class I and Class II, plus FSIS Public Health Alerts, inside a
trailing 30-day window. Human food only — the feeds also carry pet food, which
is filtered out. Class III is excluded as the boring tier. Records with no
classification yet are included, because FDA press releases carry no class at all
until openFDA assigns one weeks later.

How many that comes to is not a property of the rule — it is whatever the
government published in the window, and it changes on every refresh. It was 64
records on 2026-09-01.

The page says "existing recalls and alerts, past 30 days" rather than "active",
and the difference is deliberate. Nothing re-verifies that a recall is still
open; items leave the page by ageing out. And the 30 days is not one clock:
openFDA's date is the day FDA published its enforcement report, which trails the
recall itself by a median of 69 days, so for that source the window means
"reported within 30 days" while the RSS feed and FSIS mean "announced within 30
days". Past-30-days is the honest claim; currently-active would not be.

A Public Health Alert is **not** a recall — FSIS issues one when contaminated
product is believed to be in commerce and no recall has been requested — and the
page never calls it one. The page also never prints "Class I"; severity is shown
in plain English, in each agency's own words.

## How it runs

Static HTML. No server, no database, no model call at request time. A scheduled
GitHub Action runs the pipeline once a day, commits `data/recalls.json` when
the government has actually said something new, and dispatches the deploy
workflow, which type-checks, tests, builds and publishes to GitHub Pages. A run
that finds no news commits nothing.

## Local development

```
npm run dev        astro dev server
npm run build      static build to dist/
npm run preview    serve the built site
npm run test       vitest, against captured fixtures
npm run check      astro check (type checking)
npm run refresh    the full data pipeline
```

Node ≥22.12.0. Everything works offline against committed fixtures and data
except `npm run refresh`, which makes live calls to three government endpoints
and needs a `GEMINI_API_KEY` — without one, records publish with their verbatim
government reason instead of a headline.

## Further reading

- `CLAUDE.md` — the operating manual: environment constraints, the traps each
  data source hides, and the rules the pipeline must not break.
- `docs/design.md` — the full design and every verified data-source fact.
- `docs/build-plan.md` — ordered build steps with acceptance criteria.
