# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to work

Spawn subagents to accomplish smaller tasks. Subagents can be used for:
- Fetching research
- Code review
- Git actions
- Design
- API coding

and anything else necessary. 

## Project status: written end to end; the automation has never run

As of 2026-09-01, build steps 1–10 are done. All three sources fetch and
normalize live data — openFDA 39, FDA RSS 17, FSIS 7 — merge.ts dedupes across
them, voice.ts runs Gemini for extraction and snark, refresh.ts is the
production orchestrator with degrade-never-blank, byte-identical short-circuit,
and a `data/meta.json` sidecar listing reachable sources for the footer, and
`src/pages/index.astro` renders the page from the committed data. 206 tests pass
offline against captured fixtures.

Merge finds nothing to merge in live data, correctly: openFDA's report_date lags
recall initiation by a median of 69 days, so its 30-day window and the RSS window
are disjoint. The merge path is covered by fixtures built on real records.

⚠️ **Step 10's two new workflows have never run on GitHub.**
`.github/workflows/refresh.yml` (the six-hourly data refresh, commit, and deploy
dispatch) and `.github/workflows/fsis-probe.yml` (a manual FSIS reachability
diagnostic) exist, and their YAML parses. Nothing more than that is known about
them. Step 10's acceptance criteria — a manual dispatch producing either a real
commit or a clean no-op, and no API key anywhere in `dist/` — are both
unexercised. `static.yml` is older and step 10 did not change it.

⚠️ FSIS is proven from this machine only. Whether `impit` gets through from a
GitHub Actions runner is still unverified — a local run on 2026-09-01 again saw
no block, which says nothing about a runner. `.github/workflows/fsis-probe.yml`
is the built-but-unrun answer: dispatch it from the Actions tab and it settles
build plan step 5's open half either way. Until someone does, treat meat,
poultry and egg coverage under CI as an open risk, not a solved one.

**What is left is running those two workflows on GitHub and reading what they
say.** Do not improvise off this file alone — `docs/build-plan.md` carries the
per-step acceptance criteria and records which halves of step 10's are still
outstanding.

## What this is

A single static page listing existing US food recalls and alerts from the past
30 days. Food names in large plain type; beside each, one factual line naming the
brand, stores, states, country of origin, and lot codes to avoid. The voice is
snarky. The avoid-line is not.

Not "currently active": nothing re-verifies that a recall is still open, and the
window is not uniformly a window on announcement. See the inclusion rule.

Data refreshes every six hours via a scheduled GitHub Action. No server, no
database, no AI at request time.

## The one rule that matters most

**AI writes voice. Government APIs supply facts.**

This is not a stylistic preference — it is the project's central safety property.
People read this page to decide whether to eat something.

| Field | Source | AI allowed? |
|---|---|---|
| brand, company, product, reason, dates | openFDA columns, or the press-release `<dl>` block | **Never** |
| anything from FSIS | FSIS structured fields | **Never** |
| retailers, states, country of origin, lot codes | FDA press-release prose | Yes, extraction only |
| headline, avoidLine | — | Yes |
| displayName | the government product text it names | Yes, naming only |

Corollaries that must not be quietly eroded:

- The model is given the text of **one cited government page** and nothing else. It
  never searches the open web.
- Every record keeps a `sourceUrl` pointing at the government page it came from.
- `reason` is stored verbatim from the government text and is never rewritten.
- Snark belongs in `headline` only. `avoidLine` stays deadpan — it is the line
  someone reads while holding the product.
- `displayName` is a short common food name for the large type ("eggs", "ground
  beef"). It is the only model-written string near the product identity, and it
  **must never be rendered as the sole identifier** — a category name reads as
  the whole food group. `product` stays verbatim beside it. See `docs/design.md`
  §2.1.
- Never widen the AI's factual surface to "save a scraping step." If the `<dl>`
  parse breaks, fix the parser.

## Architecture

```
src/pages/index.astro       the only page
src/components/Recall.astro one row: big name + avoid line
data/recalls.json           published state, committed to git
data/review.json            ambiguous merges needing a human look
data/snapshots/             raw API responses, OVERWRITTEN each run
scripts/sources/*.ts        openfda | fdaRss | fsis (via impit)
scripts/pressRelease.ts     fetch + <dl> parse of one FDA announcement
scripts/normalize.ts        source rows -> Recall
scripts/merge.ts            dedupe + upgrade extracted -> verified
scripts/voice.ts            Gemini: prose extraction + snark
scripts/refresh.ts          orchestrator
```

Three sources, two speeds. **openFDA** is structured but ~weekly and lags weeks
behind announcement. **FDA RSS** is fresh but thin, so its items need the
press-release fetch. **FSIS** covers meat, poultry, and eggs, which openFDA does
not, and is both fresh and fully structured.

Every `Recall` carries a `confidence` field, which is the data model's spine:
`verified` (structured government columns — openFDA or FSIS) or `extracted`
(Gemini read press-release prose). The page labels the difference honestly.

Committed snapshots exist so that when the page is wrong you can tell whether the
government said it or the model invented it.

## Commands

```
npm run dev        astro dev server
npm run build      static build to dist/
npm run preview    serve the built site
npm run test       vitest, against captured fixtures
npm run test -- <file>   single test file
npm run refresh    the full data pipeline (needs GEMINI_API_KEY)
npm run check      astro check (type checking)
```

`npm run refresh` runs `scripts/refresh.ts` — the production entry point.
It fetches all three sources, merges, carries voice forward from the committed
`data/recalls.json` (never regenerates), applies voice for new records only,
and exits without writing when output is byte-identical to what is committed.
On empty output it exits 1 and leaves `data/recalls.json` untouched
(degrade-never-blank). Requires `GEMINI_API_KEY`; without one, records publish
with their government reason as the outage-fallback rendering.

In production nobody runs it by hand: `.github/workflows/refresh.yml` runs the
same `npm run refresh` on a `17 */6 * * *` cron, commits `data/` only when
something changed, and then dispatches `static.yml` to rebuild the site. Both
are dispatchable by hand from the Actions tab, or from a shell:

```
gh workflow run refresh.yml        # fetch, merge, voice, commit, deploy
gh workflow run static.yml         # rebuild and deploy without refetching
gh workflow run fsis-probe.yml     # is FSIS reachable from a runner?
```

`refresh` runs TypeScript directly through Node's native type stripping — there
is no build step for the pipeline. That means `scripts/` must stay within
erasable syntax: no enums, no namespaces, no parameter properties.
`erasableSyntaxOnly` in `tsconfig.json` enforces this at `npm run check`.

## Verified environment constraints

Checked against live endpoints and the npm registry on 2026-08-28. Several of
these contradict pre-2026 training data — trust this file over recollection, and
re-verify rather than assuming if something looks off.

- **Node ≥22.12.0.** Astro 7.2.9 declares `node: ">=22.12.0"` and nothing
  stricter. The earlier note here said even-numbered releases only; the local
  machine has since moved to **v25.9.0** (odd), and install, `build`, `check`
  and `test` all pass on it as of 2026-08-28. Treat odd-numbered Node as
  working-but-unsupported: it is not an LTS line, so **pin CI to an even
  release** (22 or 24) rather than matching the local version.
- **`typescript` must be 6.x, not 7.x.** `@astrojs/check@0.9.10` peer-requires
  `^5 || ^6`.
- **Pin `@google/genai` below 3.0.0.** Its own README warns v3 changes the Node
  floor.
- Pinned set: `astro@7.2.9`, `@google/genai@2.19.0`, `zod@4.5.1`,
  `typescript@6.0.3`, `vitest@4.1.11`, `fast-xml-parser@5.11.1`, `impit@0.14.4`,
  `@astrojs/check@0.9.10`, `@types/node@^24`.
- **Rejected libraries:** `rss-parser` (unmaintained since April 2023),
  `@astrojs/rss` (generates feeds, does not parse them), `@google/generative-ai`
  (deprecated).

## Traps — read before touching the relevant area

These were each found the hard way. None are hypothetical.

**Astro 7**
- `src/fetch.ts` is a **reserved filename** and gets treated as routing config.
  Data scripts live in `scripts/`.
- `compressHTML` now defaults to `'jsx'`, which collapses whitespace between
  adjacent inline elements — `<span>` beside `<em>` renders as `helloworld`. The
  config sets `compressHTML: true` deliberately. Do not "clean up" that line.
- `Astro.glob()` was removed in v6. Use a plain JSON import or `file()` from
  `astro/loaders`.
- Content-collection schemas import `z` from **`astro/zod`**; `astro:content` and
  `astro:schema` are deprecated for this. It is Zod **4**, not 3.
- The Rust compiler makes unclosed tags a hard error and no longer auto-corrects
  invalid nesting.
- `import.meta.env` values are always inlined, never coerced — `"true"` is a string.
- Vitest tests that render Astro components need `environment: 'node'`.

**Gemini / `@google/genai`**
- Class is `GoogleGenAI`, taking an options object. Not `new GoogleGenerativeAI(key)`.
- `responseMimeType` and `responseSchema` nest under **`config`**, never top-level.
- **There is no `response.parsed`.** Only `.text`, typed `string | undefined`.
  `JSON.parse` plus Zod validation is mandatory, not defensive.
- **No built-in Zod support**, and the advice this file used to give here was
  wrong in both halves. Verified against `zod@4.5.1` on 2026-08-30:
  `z.toJSONSchema()` adds `~standard` as a **non-enumerable, non-configurable**
  own property, so `JSON.stringify` **does** strip it, and
  `delete schema['~standard']` **throws `TypeError`** in strict mode — which
  every ES module is. Following the old note literally crashed on the first call.
  Round-trip through `JSON.parse(JSON.stringify(...))` instead.
- **`~standard` was never the real problem.** Gemini enforces a keyword
  allowlist, and `z.toJSONSchema` emits several non-allowlisted keywords for
  schemas this project already uses: `$schema`, `minLength` (from `.min(1)`),
  `default` (from `.default([])`), plus `const` and `maxLength`. Filter against
  the allowlist rather than stripping named keys; convert `const` to a
  single-valued `enum` so the constraint survives. See `scripts/gemini.ts`.
- Use **`responseJsonSchema`**, not `responseSchema`, when passing JSON Schema —
  the SDK requires `responseSchema` to be omitted when the former is set.
- `gemini-2.5-flash` returns **404, no longer available** (2026-08-30). Use the
  `gemini-flash-latest` alias: a pinned id fails closed, meaning no voice at all.
  The primary model does return `503` under load, so there is a delayed retry and
  a `gemini-flash-lite-latest` fallback.
- Pass the API key **explicitly**. The README says the auto-detected env var is
  `GOOGLE_API_KEY`; the maintainers' codegen guide says `GEMINI_API_KEY`. They
  contradict each other.
- The key is a GitHub Actions secret. It must never carry a `PUBLIC_` prefix or
  reach client code, or Astro will inline it into the shipped bundle.

**openFDA**
- **A zero-match query returns HTTP 404, not 200 with an empty `results`.** The
  body is `{"error":{"code":"NOT_FOUND","message":"No matches found!"}}`
  (verified live 2026-08-31). That is a *reachable source reporting an empty
  window*, and an empty window is normal — see the `report_date` lag below — so
  `fetchOpenFda` treats it as `reachable: true, recalls: []`. Check the body
  shape, never the status alone: a wrong-but-plausible URL 404s too. The 404
  body is snapshotted verbatim, so `data/snapshots/openfda.json` never implies
  the last successful fetch is current.
- Count queries need the `.exact` suffix (`count=status.exact`) or they error.
- Date-range brackets must be URL-encoded.
- Dates are `YYYYMMDD` **strings**.
- `state` is a 2-letter code; `distribution_pattern` is free text in **three**
  incompatible shapes (bare codes, full names, prose with `&` separators). FSIS
  `states` uses full names. Normalize before comparing.
- `recall_number` is **empty on `Not Yet Classified` rows**. `event_id` is not a
  safe fallback — it groups recalls and repeats across rows — so the id falls
  back to `event-<event_id>-<sha1(product)>`. See `openFdaKey`.
- `code_info` is a structured field with **free-text content** — sometimes a bare
  lot code, sometimes `"None"`, sometimes a paragraph. Store it verbatim and
  unsplit; splitting the prose invents lot codes. openFDA records still never
  need *model* extraction. `more_code_info` is absent, not empty, on some records.
- `product_type` is `"Food"` on every record and does **not** separate human from
  pet food. Pet food arrives via RSS, where the press-release `Product Type` row
  reads `Animal & Veterinary`. Filter there, by excluding on `Animal &
  Veterinary` — pet pages also contain `Food & Beverages`, so an include-rule
  admits everything.

**FDA RSS**
- Parse with `{ ignoreAttributes: false, isArray: (n) => n === 'item' }`. Without
  `isArray`, a single-item feed silently becomes an object.
- **Check the response `content-type`.** A wrong-but-plausible feed URL returns a
  404 HTML page that deserializes into garbage rather than throwing.
- `pubDate` uses the alphabetic zone `EDT`, not a numeric offset. `new Date()`
  parsing of US timezone abbreviations is not guaranteed — parse deliberately.
- The correct URL is
  `https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/food-safety-recalls/rss.xml`.

**FDA press-release pages**
- `<dd>` values repeat their own label as a `<div class="field--label">` child —
  raw text reads `"Brand Name(s) Donutful"`. Remove the label ELEMENT; do not
  strip a string prefix.
- The facts live in the `<dl class="lcds-description-list--grid">`. The page has
  two other `<dl>`s holding `Consumers:` and `Media:` phone numbers.
- **`<time datetime>` is UTC; the dates are US Eastern.** Convert before taking
  a calendar date or evening announcements land a day late.
- **No classification row exists.** RSS records carry `classification: null`.

**FSIS**
- ⚠️ Recorded as blocked by **TLS fingerprinting**, not by network or headers —
  the reason `impit` is a dependency. **This did not reproduce on 2026-08-29:**
  plain `fetch()` returned the same 12.9 MB of valid JSON that `impit` did. Keep
  using `impit` regardless — an intermittent block is worse than a permanent one,
  and the dependency is already paid for. Do not simplify to `fetch()`, and do
  not try to fix a future block with headers.
- `field_states` can contain the literal `"Nationwide"`, which a state-name
  filter drops — leaving a nationwide alert looking local. Handle it explicitly.
- `field_establishment` is populated on well under half of records; FSIS also
  publishes **no lot codes** (`field_labels` is a PDF filename). Plain-text
  fields carry HTML entities and must be decoded.
- The FSIS snapshot stores the **selected** records, not the 12.9 MB raw feed.
- **`field_active_notice` is not the recency filter** — exactly one of 2,023 live
  records is `"True"`. Use `field_recall_date` (ISO, unlike openFDA's YYYYMMDD).
- `field_recall_classification` has a fourth value, `Public Health Alert`, which
  is **included** by the inclusion rule but is not a recall class. Pass it
  through; do not drop it as unrecognised, and do not render it as a recall.
- Every recall appears **twice**, once per `langcode`. Filter to `English` or the
  page double-counts. (Spanish twins lag: the 9 most recent had none yet.)
- A June 2026 API change flipped fields from comma-joined strings to arrays. No
  live record still uses the string shape; the Zod schema accepts both anyway.
- A silent FSIS failure means meat and poultry recalls vanish while the page still
  looks complete. Any source contributing zero items must warn loudly, and the
  footer names which sources were reachable.

**GitHub Actions**
- **A push made with the default `GITHUB_TOKEN` does not start another workflow
  run.** GitHub suppresses it so workflows cannot trigger themselves forever.
  `static.yml` triggers on `push: branches: [main]`, so the data commit
  `refresh.yml` pushes would land and the site would never rebuild — every
  refresh run green, the published page frozen at whatever it was when a human
  last pushed. The documented exceptions are `workflow_dispatch` and
  `repository_dispatch`, which **do** create a run even from `GITHUB_TOKEN`, so
  `refresh.yml` ends with `gh workflow run static.yml --ref main` (gated on data
  having changed). That was chosen over a PAT — a second secret to store, rotate
  and leak — and over `workflow_call`, which would mean editing `static.yml`.
  **Do not "simplify" the dispatch step away.** It looks redundant beside
  `static.yml`'s push trigger and is not; deleting it silently freezes the site.
  It is also why `refresh.yml` needs `actions: write` on top of
  `contents: write`.
- **Change detection uses `git status --porcelain -- data/`, not
  `git diff --quiet`.** `data/meta.json` is untracked until the first successful
  run creates it, and `git diff` cannot see an untracked file — so a first run
  that produced meta and nothing else would report "no changes" and never commit
  it.
- `npm run refresh` runs bare in CI: no `|| true`, no `continue-on-error`. Its
  two non-zero exits (`refused-empty`, `aborted-unreadable-state`) are exactly
  the cases a human must look at, and swallowing them turns a stale page — or a
  page about to lose all its voice — into a green run.

## Behavioural rules for the pipeline

- **Degrade, never blank.** A failing source keeps the last good `recalls.json` and
  the page renders with an honest "last checked" timestamp. The list is never
  published empty.
- **Gemini failure is not fatal.** Retry once, then publish the item with its plain
  product name and the verbatim government reason. An item is never dropped for
  lack of a joke.
- **Never regenerate existing voice.** Gemini runs only for ids lacking a
  `headline`. This keeps the voice stable and cost near zero. **This requires
  loading the committed `recalls.json` and calling `carryVoiceForward` before
  generating** — a fresh source fetch always looks entirely unvoiced, so without
  it every run rewrites the whole page. Broken once already; see build plan
  step 7.
  For the same reason, refresh **reads the committed `recalls.json` first and
  aborts** when it exists but cannot be read or fails `RecallSchema`. Only
  `ENOENT` — the genuine first run — is allowed to yield `[]`, because `[]` is
  exactly the input that regenerates every headline. Aborting costs a run;
  guessing costs the whole page's voice and the API bill for it.
- **A run that changes nothing must not commit.** Most of the four daily runs will
  find no news; exit early when output is byte-identical to what is committed.
- **Snapshots overwrite in place.** Accumulating timestamped files would add
  hundreds of megabytes a year. Git history is the audit trail.
- **Ambiguous merges never merge.** A duplicate row is a cheap, visible failure. A
  wrong merge attaches the wrong lot codes to the wrong product, which is the one
  failure mode that could hurt someone. Ambiguous cases go to `data/review.json`
  with both entries left visible.

## Inclusion rule

Status `Ongoing`, Class I and Class II, **plus FSIS Public Health Alerts**, inside
a trailing 30-day window. Class III is excluded as the boring tier. Human food
only; the feed also carries pet food, which is filtered out.

**The count is not part of the rule.** It is whatever the government published in
that window, and it moves on every refresh — 64 records as of 2026-09-01, against
the 46 this file used to assert. Never write a number down as a property of the
rule: not here, not on the page, not in a test.

The window is also not a live-status check, and it is not one clock. Nothing
re-verifies that a recall is still open — a record leaves the page by ageing out,
not by being closed. And openFDA's date is `report_date`, which lags recall
initiation by a median of 69 days, so for that source the rule is really
"reported within 30 days" while RSS and FSIS are "announced within 30 days".
Hence the page describes its contents as **existing recalls and alerts, past 30
days** — the strongest claim the data actually supports. See `docs/design.md`
§10 q3, and do not restore "currently active" anywhere.

Records with **no classification** are also included (2026-08-29): FDA press
releases carry no class — it is assigned weeks later via openFDA — so excluding
them would empty the extracted tier of the freshest items.

The page never prints "Class I". Severity is shown in plain English via
`src/severity.ts`, which carries each agency's verbatim definition and picks FDA
vs FSIS wording by `source`. All dates are US Eastern, labelled EDT/EST per date
(`src/dates.ts`) — never a fixed offset, which would shift calendar dates.

PHAs are included deliberately (2026-08-29): FSIS issues one when contaminated
product is believed to be in commerce and **no recall has been requested**, which
by this page's standard is at least as urgent as a Class II. A PHA is **not a
recall** and the page must never call it one — see `docs/design.md` §7.

This is an editorial judgment, not a technical constraint. Changing it is a product
decision — ask, don't assume.

## External services

The user's standing rule is that external APIs are not used without explicit
instruction. These were explicitly approved for this project and no others:

- openFDA (`api.fda.gov`) — recall data
- FDA RSS and press-release pages (`www.fda.gov`) — recall announcements
- USDA FSIS (`www.fsis.usda.gov`) — meat, poultry, egg recalls
- Google Gemini (`@google/genai`) — headline and avoid-line generation

Only public government text is sent to Gemini. Do not add services beyond this
list without asking.

## Git workflow

**Work directly on `main`.** This is a deliberate, explicitly requested override of
the user's standing "always branch, always PR" rule, for a solo greenfield project.
Do not switch back to feature branches without being asked.



## Documentation

- `docs/design.md` — the full design and every verified data-source fact
- `docs/build-plan.md` — ordered steps with acceptance criteria; **start here**
- `README.md` — human-facing description

Keep these current as steps land. When a "not yet built" caveat in this file stops
being true, delete it.
