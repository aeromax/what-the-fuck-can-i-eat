# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status: schema and fixtures, no pipeline yet

As of 2026-08-29, build steps 1–2 are done: scaffold builds clean, the `Recall`
model and all three source schemas exist, and six live fixtures back 33 passing
tests. There is still no data pipeline — no source module fetches anything and
the page is a placeholder.

**Continue at `docs/build-plan.md` step 3.** Do not improvise off this file
alone — the build plan carries per-step acceptance criteria and the order
matters (the riskiest unknown is deliberately step 5, not step 8).

## What this is

A single static page listing US food recalls that are currently active. Food names
in large plain type; beside each, one factual line naming the brand, stores,
states, country of origin, and lot codes to avoid. The voice is snarky. The
avoid-line is not.

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

Corollaries that must not be quietly eroded:

- The model is given the text of **one cited government page** and nothing else. It
  never searches the open web.
- Every record keeps a `sourceUrl` pointing at the government page it came from.
- `reason` is stored verbatim from the government text and is never rewritten.
- Snark belongs in `headline` only. `avoidLine` stays deadpan — it is the line
  someone reads while holding the product.
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

⚠️ `npm run refresh` runs `scripts/refresh.ts`, which does not exist yet (build
step 8). Every other script works.

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
- **No built-in Zod support.** If bridging via `z.toJSONSchema()`, delete the
  `"~standard"` key it adds — `JSON.stringify` won't strip it and Gemini enforces a
  keyword allowlist.
- Pass the API key **explicitly**. The README says the auto-detected env var is
  `GOOGLE_API_KEY`; the maintainers' codegen guide says `GEMINI_API_KEY`. They
  contradict each other.
- The key is a GitHub Actions secret. It must never carry a `PUBLIC_` prefix or
  reach client code, or Astro will inline it into the shipped bundle.

**openFDA**
- Count queries need the `.exact` suffix (`count=status.exact`) or they error.
- Date-range brackets must be URL-encoded.
- Dates are `YYYYMMDD` **strings**.
- `state` is a 2-letter code; `distribution_pattern` is free text in **three**
  incompatible shapes (bare codes, full names, prose with `&` separators). FSIS
  `states` uses full names. Normalize before comparing.
- `code_info` carries lot codes as a structured column — openFDA records never
  need extraction. `more_code_info` is absent, not empty, on some records.
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
- `<dd>` values repeat their own label inline: the brand cell reads
  `"Brand Name(s) Donutful"`. Strip the duplicated prefix.
- The same `<dl>` carries `Consumers:` and `Media:` contact rows. Ignore them.

**FSIS**
- ⚠️ Recorded as blocked by **TLS fingerprinting**, not by network or headers —
  the reason `impit` is a dependency. **This did not reproduce on 2026-08-29:**
  plain `fetch()` returned the same 12.9 MB of valid JSON that `impit` did. Keep
  using `impit` regardless — an intermittent block is worse than a permanent one,
  and the dependency is already paid for. Do not simplify to `fetch()`, and do
  not try to fix a future block with headers.
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

## Behavioural rules for the pipeline

- **Degrade, never blank.** A failing source keeps the last good `recalls.json` and
  the page renders with an honest "last checked" timestamp. The list is never
  published empty.
- **Gemini failure is not fatal.** Retry once, then publish the item with its plain
  product name and the verbatim government reason. An item is never dropped for
  lack of a joke.
- **Never regenerate existing voice.** Gemini runs only for ids lacking a
  `headline`. This keeps the voice stable and cost near zero.
- **A run that changes nothing must not commit.** Most of the four daily runs will
  find no news; exit early when output is byte-identical to what is committed.
- **Snapshots overwrite in place.** Accumulating timestamped files would add
  hundreds of megabytes a year. Git history is the audit trail.
- **Ambiguous merges never merge.** A duplicate row is a cheap, visible failure. A
  wrong merge attaches the wrong lot codes to the wrong product, which is the one
  failure mode that could hurt someone. Ambiguous cases go to `data/review.json`
  with both entries left visible.

## Inclusion rule

Status `Ongoing`, Class I and Class II, **plus FSIS Public Health Alerts**,
announced within 30 days — roughly 46 items. Class III is excluded as the boring
tier. Human food only; the feed also carries pet food, which is filtered out.

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
