# Build plan

> **Provenance note.** Reconstructed on 2026-08-28 from `CLAUDE.md`. The step
> ordering honours the one constraint `CLAUDE.md` records explicitly — *"the
> riskiest unknown is deliberately step 5, not step 8"* — which places FSIS at
> step 5. The acceptance criteria are derived from the invariants in
> `docs/design.md`; they were not transcribed from an original document. Treat
> them as a strong proposal rather than as previously-approved text, and correct
> anything that contradicts your memory of the design conversation.

Read `docs/design.md` first. In particular §2 (the AI/facts boundary) and §6
(pipeline invariants) constrain almost every step below.

## Why this order

Two principles:

**Front-load the thing that can kill the project.** FSIS is reached through
Akamai TLS fingerprinting via `impit`. It works locally today. Whether it works
from a GitHub Actions runner — different IP reputation, different egress, an
adversary that updates its heuristics — is the single unknown that could force a
design change rather than a bug fix. If `impit` fails on CI, the options are all
expensive (a proxy, a browser, dropping meat recalls entirely) and all of them
change the shape of the project. Learn that at step 5, not at step 10 with a
finished site.

**Build the tiers in confidence order.** openFDA before RSS before merge, because
`verified` is the simpler tier, and because a merge cannot be tested until there
are two kinds of thing to merge.

Voice comes late. It is the most visible part of the product and the least
structurally risky: it has a defined fallback (§6, "Gemini failure is not
fatal"), so a total failure degrades to a plain product name rather than
blocking.

---

## Step 1 — Scaffold

Create the repository skeleton. Nothing fetches anything yet.

- `git init`; work directly on `main` (deliberate override of the standing
  branch-and-PR rule, for this solo greenfield project).
- `package.json` with the pinned dependency set from design §8. Pin exactly; do
  not use `^` on the packages named there.
- `astro.config.mjs` with `compressHTML: true` set explicitly, and a comment
  saying why (design §8 — the `'jsx'` default eats whitespace between inline
  elements).
- `tsconfig.json`, `vitest.config.ts` with `environment: 'node'`.
- Empty `data/` and `scripts/` directories; `data/snapshots/.gitkeep`.
- `.gitignore` — and confirm `data/` is **not** in it. `recalls.json`,
  `review.json`, and the snapshots are all committed on purpose.
- npm scripts: `dev`, `build`, `preview`, `test`, `refresh`, `check`.

**Accept when:** `npm run check` and `npm run build` both pass on an empty site;
`node -v` reports ≥22.12.0 and even-numbered; `npm ls typescript` shows 6.x.

**Then:** delete the "none of these exist yet" warning above the command list in
`CLAUDE.md`.

## Step 2 — Types, schema, fixtures ✅ done 2026-08-29

Delivered: `src/recall.ts` (Recall type, Zod schema, `makeId`),
`scripts/sourceSchemas.ts` (raw shapes for all three sources plus the press
release), six fixtures in `tests/fixtures/`, and 33 passing tests.

Open question 1 is resolved — see design §10. Five live-data findings were folded
back into design §4, three of which change later steps: the pet-food filter moves
to the RSS path, FSIS recency must use `field_recall_date` rather than
`field_active_notice`, and `Public Health Alert` needs an editorial ruling
(new open question 5) before step 5 can filter correctly.

<details><summary>Original acceptance criteria</summary>

The `Recall` type and its Zod schema, plus captured fixtures for every later
step to test against.

- `Recall` as specified in design §3, with `confidence: 'verified' | 'extracted'`.
- Zod schema importing `z` from **`astro/zod`** (Zod 4, not 3).
- Capture one real response from each source into `tests/fixtures/` by hand —
  an openFDA page, the RSS feed, one press-release HTML page, one FSIS response.
  These are checked in and are what `npm run test` runs against. The test suite
  must not hit the network.
- Resolve open question 1 from design §10: how `id` is derived per source.

**Accept when:** the schema round-trips all four fixtures; `npm run test` passes
with the network unavailable.

</details>

**Step 1 is also complete** (2026-08-29): scaffold builds, `check`/`build`/`test`
green, git initialised on `main`. Note that the "Node even-numbered only"
constraint did not reproduce — see CLAUDE.md.

## Step 3 — openFDA source + normalize

The `verified` tier, simplest path first.

- `scripts/sources/openfda.ts` — query with the inclusion rule from design §7
  (`Ongoing`, Class I and II, 30 days, human food only).
- URL-encode the date-range brackets. Dates are `YYYYMMDD` strings. Any count
  query needs `.exact`.
- `scripts/normalize.ts` — source rows to `Recall`, `confidence: 'verified'`.
- Normalise `state` (2-letter) against full state names now, not later; design §4
  flags this as a silent under-match across sources.
- Write the raw response to `data/snapshots/openfda.json`.

**Accept when:** a live run yields a plausible count of validated `Recall`
objects, none of which has a `headline`; pet food is absent; every record has a
`sourceUrl`; the fixture test passes offline.

## Step 4 — FDA RSS + press-release parsing

The `extracted` tier's factual half. No model involved in this step at all —
that is the point.

- `scripts/sources/fdaRss.ts` using the exact feed URL from design §4.
- `fast-xml-parser` with `{ ignoreAttributes: false, isArray: (n) => n === 'item' }`.
- **Check `content-type` before parsing.** A wrong URL returns 404 HTML that
  deserialises to garbage without throwing.
- Parse `pubDate` deliberately — it carries the alphabetic zone `EDT`.
- `scripts/pressRelease.ts` — fetch one announcement, parse the `<dl>`, strip the
  duplicated label prefix from each `<dd>` (`"Brand Name(s) Donutful"` →
  `"Donutful"`), and ignore the `Consumers:` and `Media:` contact rows.
- Normalize to `Recall` with `confidence: 'extracted'` and the prose fields
  (`retailers`, `states`, `countryOfOrigin`, `lotCodes`) left empty — step 7
  fills them.

**Accept when:** brand, company, product, reason and dates for a fixture press
release all come out of the `<dl>` with no model call anywhere in the path;
`reason` is byte-identical to the source text; a single-item feed produces an
array of one.

## Step 5 — FSIS via impit ⚠️ **the risky one**

Meat, poultry, eggs. Do this before building anything on top of it.

- `scripts/sources/fsis.ts` using `impit`, not `fetch`. The block is TLS
  fingerprinting; headers and User-Agent are irrelevant and changing them is a
  known dead end (design §4).
- Filter `langcode` to `English` or every recall double-counts.
- Include `Public Health Alert` alongside Class I and II (decision 2026-08-29,
  design §7). Recency comes from `field_recall_date`, **not**
  `field_active_notice` — only one live record in 2,023 is flagged active.
- Zod schema must accept both the pre- and post-June-2026 shapes for the ten
  fields that flipped from comma-joined strings to arrays. Determine which ten
  from a live response — design §4 marks this unverified.
- `confidence: 'verified'`; `states` uses full names.
- Loud failure: a source returning zero items must warn, not shrug.

**Accept when:** it works locally, **and** a throwaway GitHub Actions workflow
proves it works from a runner. Do not proceed to step 6 on local success alone —
proving this on CI is the entire reason the step is here.

**If it fails on CI:** stop and raise it. The fallbacks all change the project's
shape and are a product decision, not an implementation detail.

## Step 6 — merge

Dedupe across sources, and upgrade `extracted` to `verified` when openFDA
eventually publishes a row for something RSS reported weeks earlier.

- Match on the `id` scheme from step 2, with the state-name normalisation from
  step 3.
- On a confident match where one side is `verified`: the verified record wins
  every factual field. Carry `headline` and `avoidLine` across so voice is not
  regenerated (§6).
- **On ambiguity: do not merge.** Write both entries to `data/review.json` and
  leave both visible on the page. Resolve open question 2 from design §10 here,
  and tune the threshold to over-produce review entries. A duplicate row is
  cheap; wrong lot codes on the wrong product is the failure this whole rule
  exists to prevent.

**Accept when:** a fixture pair that should merge does, preserving existing
voice; a deliberately ambiguous fixture pair lands in `review.json` with both
records intact; no test case produces a merged record mixing lot codes from two
different products.

## Step 7 — voice (Gemini)

Two jobs in one script, both constrained by design §2.

- `GoogleGenAI` with an options object; API key passed **explicitly** (the two
  official docs disagree on the env var name). No `PUBLIC_` prefix, ever.
- `responseMimeType` and `responseSchema` go under `config`.
- **There is no `response.parsed`.** `JSON.parse(response.text)` then Zod
  validate. If bridging a Zod schema via `z.toJSONSchema()`, delete the
  `"~standard"` key it inserts.
- **Extraction call:** given the text of *one* press-release page, return
  `retailers`, `states`, `countryOfOrigin`, `lotCodes`. Spans from the supplied
  text only. One page per call — never two, or facts can blend.
- **Voice call:** `headline` (snarky) and `avoidLine` (deadpan, factual, the line
  someone reads while holding the product).
- Runs **only for ids lacking a `headline`**.
- Retry once on failure, then publish the item with its plain product name and
  verbatim reason. Never drop an item for lack of a joke.

**Accept when:** re-running against unchanged input makes zero API calls; a
forced failure still produces a publishable record; every extracted lot code is
findable by string search in the source page; `brand`, `company`, `product`,
`reason` and dates are provably untouched by the model.

## Step 8 — refresh orchestrator

`scripts/refresh.ts` wires steps 3–7 together.

- Run all three sources; a single source failing does not abort the run.
- Write snapshots, overwriting in place.
- **Degrade, never blank** — on failure keep the last good `recalls.json`.
- Record which sources were reachable, for the footer.
- **Exit without committing if output is byte-identical** to what is committed.

**Accept when:** killing each source in turn still publishes a complete-looking
page with an honest footer; two consecutive runs against unchanged upstream data
produce no second commit; `recalls.json` is never written empty.

## Step 9 — the page

`src/pages/index.astro` and `src/components/Recall.astro`.

- Food name large and plain; one avoid-line beneath.
- The `verified` / `extracted` distinction shown honestly.
- **A Public Health Alert must not read as a recall** — no recall to invoke, no
  refund path, so the avoid-line carries all the actionable content. Same
  labelling problem as the confidence tiers; solve them together. Design §7.
- Footer: "last checked" timestamp and which sources were reachable.
- `review.json` entries render as separate rows, both visible.
- Import the JSON plainly or via `file()` from `astro/loaders` — `Astro.glob()`
  is gone.
- Watch nesting: unclosed tags are a hard compile error now.

**Accept when:** `npm run build` succeeds; no `<span>`/`<em>` whitespace
collapse; the page is readable at arm's length on a phone; a reader can tell
which rows are model-extracted.

## Step 10 — GitHub Action

- Cron every six hours; `workflow_dispatch` too.
- `GEMINI_API_KEY` as a repository secret.
- Commit `recalls.json`, `review.json`, and snapshots only when step 8 says
  something changed.
- Resolve open question 4 from design §10 — what publishes `dist/`.

**Accept when:** a manual dispatch produces either a commit with real changes or
a clean no-op; the key does not appear anywhere in `dist/`.

---

## Running notes

Keep `CLAUDE.md`, `docs/design.md` and this file current as steps land. When a
"not yet built" caveat stops being true, delete it rather than annotating it.
