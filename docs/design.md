# Design

> **Provenance note.** This file was reconstructed on 2026-08-28 from `CLAUDE.md`,
> which is the surviving record of the original design conversation. Every
> data-source fact below is transcribed from that file, where it is recorded as
> having been checked against live endpoints on 2026-08-28. Facts NOT recorded in
> `CLAUDE.md` — exact JSON field names of the upstream APIs, the precise `<dl>`
> label strings, the FSIS query parameters — are marked **(unverified)** and must
> be confirmed against a live response before code depends on them. Do not treat
> an unverified line here as approved design.

## 1. The product

A single static page listing US food recalls that are currently active.

Each row is a food name in large plain type, and beneath it one factual line
naming the brand, the stores, the states, the country of origin, and the lot
codes to avoid.

The voice is snarky. The avoid-line is not.

There is no server, no database, and no model call at request time. The page is
static HTML; the data behind it is a JSON file committed to git and refreshed
every six hours by a scheduled GitHub Action.

### Who it is for

Someone standing in a kitchen or a supermarket aisle holding a package, wanting
to know in about four seconds whether the thing in their hand is the thing on the
news. The snark is what gets them to the page. The avoid-line is what they
actually read. These two jobs are in tension and the design resolves that tension
by keeping them in separate fields that are generated under separate rules.

## 2. The central safety property

**AI writes voice. Government APIs supply facts.**

This is not a stylistic preference. People read this page to decide whether to
eat something. A hallucinated lot code is not a cosmetic bug.

| Field | Source | AI allowed? |
|---|---|---|
| brand, company, product, reason, dates | openFDA columns, or the press-release `<dl>` block | **Never** |
| anything from FSIS | FSIS structured fields | **Never** |
| retailers, states, country of origin, lot codes | FDA press-release prose | Yes, extraction only |
| headline, avoidLine | — | Yes |
| displayName | the government product text it names | Yes, naming only — see §2.1 |

Four corollaries, none of which may be quietly eroded:

- The model is given the text of **one cited government page** and nothing else.
  It never searches the open web. It is never given two pages at once, because
  then it could blend them.
- Every record keeps a `sourceUrl` pointing at the government page it came from.
  A reader who does not believe the page can go read the source.
- `reason` is stored verbatim from the government text and is never rewritten,
  summarised, or "cleaned up".
- Snark belongs in `headline` only. `avoidLine` stays deadpan — it is the line
  someone reads while holding the product.

The standing temptation this project will face is to widen the model's factual
surface to save a scraping step: to let it read the whole page and just return
everything, rather than parsing a `<dl>` and asking it only for the prose bits.
Do not. If the `<dl>` parse breaks, fix the parser.

### 2.1 `displayName`, and why it is the one exception

The large type needs a food name — "eggs", "ground beef", "lettuce" — but
`product` holds the government's spec line, which is unusable as a heading and
which §2 forbids the model from rewriting. `displayName` resolves that: the model
writes a short common name for the food, and `product` stays verbatim beside it.

This is a naming task, not a factual one, but it carries a specific hazard that
must be designed against rather than trusted away:

**A category name generalizes.** One recalled brand of eggs becomes "eggs", which
a hurried reader can take to mean every egg in the shop. That is a false alarm in
the safe direction, but it is still wrong, and repeated often enough it trains
people to ignore the page.

Three rules keep it honest, and none of them are optional:

1. **Never rendered alone.** The identifying detail — brand, pack size, lot
   codes, the `avoidLine` — is always adjacent. A layout that shows
   `displayName` as the sole identifier is a bug, not a style choice.
2. **`product` is never discarded.** It stays on the record verbatim, so the
   specific thing recalled is always recoverable and always citable.
3. **Naming only.** The model may name the food it was given. It may not decide
   whether the food is dangerous, who sold it, or which lots are affected — those
   come from government columns exactly as before.

Failure is cheap by construction: `displayName` is nullable and the page falls
back to `product`, so a bad or missing generation costs legibility, never facts.

**Presentation note for step 9.** Rule 1 has a cost worth designing around: some
`product` values are a full paragraph — one live eggs record lists five pack
configurations with UPCs across ten lines — so pairing a two-word heading with
the verbatim text puts a wall of grey under "eggs". Collapsing it behind a
disclosure control is fine. Removing it is not.

### What "extraction only" means operationally

For the four extractable fields the model is asked to return spans that appear in
the supplied text, not to answer questions about it. A lot code it returns should
be findable in the source page by string search. This is the property that makes
the `extracted` confidence tier honest rather than decorative.

## 3. Data model

The `Recall` record is the whole data model. Its spine is `confidence`:

- `verified` — every fact came from structured government columns (openFDA or
  FSIS). No model output in any factual field.
- `extracted` — a model read press-release prose to obtain retailers, states,
  country of origin, or lot codes.

The page labels the difference honestly. It does not silently present the two
tiers as equivalent, because they are not.

Fields (implemented in `src/recall.ts`, step 2):

| Field | Notes |
|---|---|
| `id` | `source:nativeKey`, stable across runs; **not** the cross-source merge key — see §10.1 |
| `product` | the government's verbatim product text; never shortened, never model-written |
| `displayName` | short common food name for the large type; model-written, never shown alone — see §2.1 |
| `brand`, `company` | never model-written |
| `reason` | verbatim government text, never rewritten |
| `retailers`, `states`, `countryOfOrigin`, `lotCodes` | structured on the verified tier, model-extracted on the extracted tier |
| `distributionRaw` | verbatim government distribution text; the fallback when the `states` parse under-reports |
| `nationwide` | set when the source says the product went everywhere; prevents an empty `states` list reading as "not near me" |
| `announcedDate` | drives the 30-day window |
| `status` | inclusion is `Ongoing` only |
| `classification` | Class I, Class II, and FSIS `Public Health Alert` — see §7 |
| `source` | `openfda` \| `fdaRss` \| `fsis` |
| `sourceUrl` | the cited government page |
| `confidence` | `verified` \| `extracted` |
| `headline` | snark; model-written |
| `avoidLine` | deadpan; model-written |

`headline` and `avoidLine` are written once and then frozen — see §6.

## 4. Sources: three of them, at two speeds

**openFDA** (`api.fda.gov`) — structured, authoritative, and the basis of the
`verified` tier. Updates roughly weekly and lags weeks behind the public
announcement. Good facts, late.

**FDA RSS** (`www.fda.gov`) — fresh, but each item is thin: a title, a link, a
date. To become a usable record an item must have its press-release page fetched
and parsed. This is the only path that produces `extracted` records.

**FSIS** (`www.fsis.usda.gov`) — meat, poultry, and eggs, which openFDA does not
cover at all. Both fresh *and* fully structured, so it lands on the `verified`
tier directly.

The three overlap. openFDA will eventually publish rows for recalls that arrived
weeks earlier via RSS. That overlap is not a nuisance to be suppressed — it is
the upgrade path, and `merge.ts` exists to exploit it: an `extracted` record is
replaced by the `verified` one when the structured row finally appears.

### Verified source facts

Recorded in `CLAUDE.md` as checked against live endpoints on 2026-08-28. Several
contradict pre-2026 training data. Trust these over recollection.

**openFDA**
- Count queries need the `.exact` suffix (`count=status.exact`) or they error.
- Date-range brackets must be URL-encoded.
- Dates are `YYYYMMDD` **strings**, not numbers and not ISO.
- `state` is a 2-letter code. `distribution_pattern` is free text. **Confirmed
  2026-08-29 to be worse than "full state names":** across 43 live records it
  appears as bare codes (`"MD, VA, NY"`), full names
  (`"Arkansas, Louisiana, …"`), and prose with a preamble and `&` separators
  (`"Product was shipped to the following states: AL, GA, … & WV."`). All three
  shapes must be handled — 21 distinct shapes across 43 records, including
  `"only in OR."`, `"Distributed to Nevada for further distribution."` and two
  that name no state at all. FSIS `states` uses full names. This is a real
  cross-source join and it silently under-matches if skipped.
  The parser (`scripts/states.ts`) matches state codes **case-sensitively**,
  which is what keeps the word "in" from becoming Indiana while still reading
  `OR` as Oregon. It deliberately over-reports rather than under-reports: a
  spurious state is a false alarm, a missing one hides a recall from someone
  standing in that state.
- **`code_info` is a structured field with free-text content** — a weaker claim
  than this document previously made. Present on all 43 captured records
  (`more_code_info` is absent, not empty, on 3 of 43), but the content ranges
  from a bare lot code (`"Selec1011"`) through `"None"` to a full paragraph
  explaining where on the carton to look. It is therefore stored **verbatim and
  unsplit**: parsing that prose into a list would invent lot codes that do not
  exist, which is precisely the failure the AI/facts boundary exists to prevent.
  The important half of the original claim still holds — openFDA records never
  need *model* extraction, because whatever the government wrote reaches the page
  on the verified tier without a model seeing it.
- **`product_type` is `"Food"` on every record and does not distinguish human
  from pet food.** The inclusion rule's pet-food filter cannot be implemented
  here. Verified 2026-08-29: the 30-day window contained no pet food at all —
  it arrives via RSS, so the filter belongs in that path. See below.

**FDA RSS**
- The correct URL is
  `https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/food-safety-recalls/rss.xml`
- Parse with `{ ignoreAttributes: false, isArray: (n) => n === 'item' }`.
  Without `isArray`, a single-item feed silently deserialises to an object
  instead of a one-element array.
- **Check the response `content-type`.** A wrong-but-plausible feed URL returns a
  404 HTML page that deserialises into garbage rather than throwing. A parser
  that trusts a 200 will happily produce zero items and report success.
- `pubDate` uses the alphabetic zone `EDT`, not a numeric offset. `new Date()`
  parsing of US timezone abbreviations is not guaranteed across runtimes. Parse
  deliberately.

**FDA press-release pages**
- Facts live in a `<dl>` block. Parse it; do not hand the page to the model.
- `<dd>` values repeat their own label inline: the brand cell reads
  `"Brand Name(s) Donutful"`. Strip the duplicated prefix.
- The same `<dl>` carries `Consumers:` and `Media:` contact rows. Ignore them —
  they are phone numbers, not product facts. **They are separate `<dl>` elements**;
  the facts live in the one with class `lcds-description-list--grid`, so select
  that block rather than filtering labels out of a merged list.
- **The duplicated label is an element, not a string prefix.** The `<dd>` contains
  `<div class="field--label">Brand Name(s)</div>` beside
  `<div class="field--item">Donutful</div>`. Removing the label element is
  strictly better than stripping a duplicated string prefix, because it cannot
  damage a value that legitimately begins with its own label text.
- **`<time datetime>` is UTC and the dates are US Eastern.** An evening
  announcement carries a UTC instant on the following day —
  `datetime="2026-08-25T00:36:00Z"` on a page that reads *August 24, 2026*.
  Slicing the ISO string misdates the record and shifts it within the 30-day
  window. Convert to `America/New_York` first.
- Confirmed labels (2026-08-29): `Company Announcement Date`, `FDA Publish Date`,
  `Product Type`, `Reason for Announcement`, `Company Name`, `Brand Name`,
  `Product Description`. **No classification row exists** — see §7.
- Product names on this path are already short and clean ("Mangoes", "Jalapeno
  Ranch Dressing"), unlike openFDA's spec lines, so `displayName` matters far
  less here.
- **`Product Type:` is the pet-food discriminator, and it is structured.**
  Human items read `"Food & Beverages …"`; pet items read
  `"Animal & Veterinary Food & Beverages …"`. Note that pet items contain
  `"Food & Beverages"` *too*, so the rule must be **exclude on
  `Animal & Veterinary`**, never include on `Food & Beverages` — the latter
  admits every pet recall. Verified against both fixtures on 2026-08-29.
  This removes the need for keyword guessing on product names.
- Confirmed `<dl>` labels (2026-08-29): `Company Announcement Date`,
  `FDA Publish Date`, `Product Type`, `Reason for Announcement`, `Company Name`,
  `Brand Name`, `Product Description`. Three `<dl>` blocks exist on the page;
  the facts are in the first.

**FSIS**
- Recorded as blocked by **TLS fingerprinting** — Akamai rejecting non-browser
  TLS handshakes regardless of IP or User-Agent — which is why `impit` is a
  dependency. **This did not reproduce on 2026-08-29.** From this machine, plain
  `fetch()` returned HTTP 200 with 12.9 MB of valid JSON (2,023 records),
  identical to what `impit` returned. Either the block was lifted, Akamai's
  policy varies by IP reputation, or it is applied intermittently.
  **Keep using `impit` anyway.** A block that comes back intermittently is worse
  than one that is always on, and the cost of the dependency is already paid.
  Do not "simplify" this to plain `fetch()` on the strength of one good day, and
  do not attempt to fix a future block by changing headers — that path was
  already walked. Step 5 still has to prove this from a GitHub runner.
- **`field_active_notice` is not the recency filter.** Across all 2,023 live
  records exactly **one** is `"True"` (1,833 `"False"`, 189 empty). Filtering on
  it publishes a one-item page. Recency must come from `field_recall_date`,
  which is ISO `YYYY-MM-DD` — unlike openFDA's `YYYYMMDD`.
- `field_recall_classification` carries a fourth value outside the Class scheme:
  **`Public Health Alert`** (170 of 2,023; 2 of the 9 in the last 30 days). See
  §7 and open question 5.
- Every recall appears **twice**, once per `langcode`. Filter to `English` or the
  page double-counts every meat recall.
- A June 2026 API change flipped fields from comma-joined strings to arrays.
  Confirmed 2026-08-29: `field_states`, `field_product_items`,
  `field_establishment`, `field_labels`, `field_distro_list`,
  `field_recall_reason`, `field_processing` are arrays, and **zero** live records
  still use the string shape. The Zod schema accepts both anyway — the union
  costs one line, and the failure it guards against is meat recalls silently
  vanishing. The string branch is exercised by a synthetic fixture, since live
  data no longer covers it.
- A silent FSIS failure means meat and poultry recalls vanish while the page
  still looks complete and confident. This is the worst failure mode in the
  system that does not involve wrong text, and it is why zero-item sources must
  warn loudly and the footer must name which sources were reachable.

## 5. Architecture

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

Data flows one way:

```
sources/*  ->  normalize  ->  merge  ->  voice  ->  recalls.json  ->  index.astro
                                 |
                                 +-->  review.json   (ambiguous pairs)
                 snapshots/  <---+     (raw responses, per run)
```

`voice.ts` sits deliberately *after* `merge.ts`: merging can upgrade an
`extracted` record to `verified`, and there is no point paying for extraction on
a record that is about to be replaced by structured columns.

Committed snapshots exist for one reason: when the page is wrong, you need to be
able to tell whether the government said it or the model invented it. Git history
is the audit trail, which is why snapshots overwrite in place rather than
accumulating timestamped files (that would add hundreds of megabytes a year).

## 6. Pipeline behaviour

These are invariants, not preferences.

- **Degrade, never blank.** A failing source keeps the last good `recalls.json`
  and the page renders with an honest "last checked" timestamp. The list is never
  published empty. An empty page reads as "nothing is recalled", which is a
  factual claim the pipeline is in no position to make.
- **Gemini failure is not fatal.** Retry once, then publish the item with its
  plain product name and the verbatim government reason. An item is never dropped
  for lack of a joke.
- **Never regenerate existing voice.** Gemini runs only for ids lacking a
  `headline`. This keeps the voice stable run-to-run and holds cost near zero —
  most runs generate nothing.
- **A run that changes nothing must not commit.** Most of the four daily runs
  find no news. Exit early when output is byte-identical to what is committed,
  or the repo accrues four empty commits a day forever.
- **Snapshots overwrite in place.**
- **Ambiguous merges never merge.** A duplicate row is a cheap, visible failure —
  a reader sees the same recall twice and is mildly annoyed. A wrong merge
  attaches the wrong lot codes to the wrong product, which is the one failure
  mode in this system that could actually hurt someone. Ambiguous cases go to
  `data/review.json` with both entries left visible on the page.

The asymmetry in that last rule is the design's whole posture in miniature:
when uncertain, be redundant rather than confident.

## 7. Inclusion rule

Status `Ongoing`, Class I and Class II, **plus FSIS Public Health Alerts**,
announced within 30 days — roughly 46 items at the time of design, plus ~2 PHAs
per 30-day window.

Class III is excluded as the boring tier. Human food only; the feed also carries
pet food, which is filtered out.

This is an **editorial judgment, not a technical constraint**. Changing it is a
product decision — ask, don't assume.

### Unclassified records (found at step 4, 2026-08-29)

⚠️ **Editorial — confirm this reading.** FDA press releases carry **no
classification at all**: the `<dl>` has no such row, and the class is assigned
weeks later through openFDA. That lag is the entire reason the RSS path exists.

The inclusion rule as written admits Class I and II, which would reject every RSS
record and empty the `extracted` tier — deleting the freshest items on the page,
which are also the ones most likely to still be on a shelf.

So `classification` is nullable and null means "not yet classified", which is
included and labelled as such. This follows the same reasoning as the PHA
decision below: the rule's intent is "food you should not eat right now", and a
recall announced yesterday meets it whether or not a clerk has graded it yet.
Excluding it would be the literal reading; including it is the safe one.

### Public Health Alerts (decision 2026-08-29)

FSIS emits a fourth `field_recall_classification` value that is not a recall
class: `Public Health Alert`. FSIS issues one when contaminated product is
believed to be in commerce **but no recall has been requested** — often because
the producer cannot be identified or will not act.

They are included. The rule as originally written (Class I and II) would have
dropped them silently, and by this page's own standard — food you should not eat
right now — a PHA is at least as urgent as a Class II, precisely because nothing
has been withdrawn from shelves. Roughly 2 of every 9 recent FSIS items.

Two consequences that must not be lost:

- **The page must not call a PHA a recall.** It is not one, and describing it as
  one would be the page stating something the government did not. This lands in
  step 9 alongside the `verified`/`extracted` labelling: whatever visual
  treatment distinguishes those two also has to carry "alert, not recall".
- **`avoidLine` matters more here, not less.** For a recall, a reader can often
  just return the product. For a PHA there may be no recall to invoke and no
  refund path — the line is the entire actionable content.

## 8. Environment constraints

Checked against the npm registry on 2026-08-28. Several contradict pre-2026
training data.

- **Node ≥22.12.0, even-numbered only.** Astro 7 hard-fails otherwise. Local
  machine is v22.22.2.
- **`typescript` must be 6.x, not 7.x.** `@astrojs/check@0.9.10` peer-requires
  `^5 || ^6`.
- **Pin `@google/genai` below 3.0.0.** Its README warns v3 changes the Node floor.
- Pinned set: `astro@7.2.9`, `@google/genai@2.19.0`, `zod@4.5.1`,
  `typescript@6.0.3`, `vitest@4.1.11`, `fast-xml-parser@5.11.1`, `impit@0.14.4`,
  `@astrojs/check@0.9.10`, `@types/node@^24`.
- **Rejected:** `rss-parser` (unmaintained since April 2023), `@astrojs/rss`
  (generates feeds, does not parse them), `@google/generative-ai` (deprecated).

### Astro 7 traps

- `src/fetch.ts` is a **reserved filename** and gets treated as routing config.
  This is why data scripts live in `scripts/`, not `src/`.
- `compressHTML` now defaults to `'jsx'`, which collapses whitespace between
  adjacent inline elements — `<span>` beside `<em>` renders as `helloworld`. The
  config sets `compressHTML: true` deliberately. Do not "clean up" that line.
- `Astro.glob()` was removed in v6. Use a plain JSON import or `file()` from
  `astro/loaders`.
- Content-collection schemas import `z` from **`astro/zod`**; `astro:content` and
  `astro:schema` are deprecated for this. It is Zod **4**, not 3.
- The Rust compiler makes unclosed tags a hard error and no longer auto-corrects
  invalid nesting.
- `import.meta.env` values are always inlined, never coerced — `"true"` is a
  string.
- Vitest tests that render Astro components need `environment: 'node'`.

### Gemini / `@google/genai` traps

- Class is `GoogleGenAI`, taking an options object. Not
  `new GoogleGenerativeAI(key)`.
- `responseMimeType` and `responseSchema` nest under **`config`**, never
  top-level.
- **There is no `response.parsed`.** Only `.text`, typed `string | undefined`.
  `JSON.parse` plus Zod validation is mandatory, not defensive.
- **No built-in Zod support.** If bridging via `z.toJSONSchema()`, delete the
  `"~standard"` key it adds — `JSON.stringify` won't strip it and Gemini enforces
  a keyword allowlist.
- Pass the API key **explicitly**. The README says the auto-detected env var is
  `GOOGLE_API_KEY`; the maintainers' codegen guide says `GEMINI_API_KEY`. They
  contradict each other.
- The key is a GitHub Actions secret. It must never carry a `PUBLIC_` prefix or
  reach client code, or Astro inlines it into the shipped bundle.

## 9. External services

The user's standing rule is that external APIs are not used without explicit
instruction. These four were explicitly approved for this project and no others:

- openFDA (`api.fda.gov`) — recall data
- FDA RSS and press-release pages (`www.fda.gov`) — recall announcements
- USDA FSIS (`www.fsis.usda.gov`) — meat, poultry, egg recalls
- Google Gemini (`@google/genai`) — headline and avoid-line generation

Only public government text is sent to Gemini. Do not add services beyond this
list without asking.

## 10. Open questions

Not settled by `CLAUDE.md`; resolve before or during the step they block.

1. ~~**`id` derivation.**~~ **Resolved 2026-08-29 (step 2).** Ids are namespaced
   per source: `` `${source}:${nativeKey}` `` — `openfda:h-1219-2026`,
   `fsis:018-2026`, `fdaRss:<press-release-slug>`. The premise that an id must be
   "comparable across sources" was wrong and dropped: openFDA and FSIS recall
   numbers collide in shape (`018-2026`) while meaning different recalls, so a
   shared id space would invite exactly the wrong merge. The id is therefore
   **not** the cross-source merge key — it only has to be stable for one source
   across runs, which is what lets `voice.ts` skip records that already have a
   headline. Cross-source matching is `merge.ts`'s job, done on content with
   ambiguity routed to `review.json`. See `src/recall.ts`.
2. **Merge ambiguity threshold.** What counts as "ambiguous" rather than
   "matched"? Blocks step 6, and the safety asymmetry in §6 means the threshold
   should be tuned to over-produce `review.json` entries, not under-produce them.
3. **The 30-day clock.** Measured from announcement date, but openFDA's
   `report_date` and the RSS `pubDate` for the same recall differ by weeks. Which
   one governs? Affects which items fall out of the window and when.
   **Step 3 uses `report_date`** as the only date openFDA offers for this, and
   stores it as `announcedDate`. That is provisional: when merge.ts starts
   upgrading an RSS record to its openFDA twin, the same recall will carry two
   different `announcedDate` values depending on which source won, and the older
   one can push it out of the window. Resolve before step 6.
4. **Deploy target.** The GitHub Action refreshes data; what publishes `dist/`
   is unspecified.
5. ~~**FSIS `Public Health Alert`.**~~ **Resolved 2026-08-29: include them**, as
   the safer reading. Step 5 no longer blocked. The remaining work is
   presentational and lands in step 9 — a PHA must not be labelled a recall.
   See §7.
6. ~~**`product` is not a food name on the openFDA path.**~~ **Resolved
   2026-08-29: a model-written `displayName`.** The large type gets a short
   common food name ("eggs", "ground beef", "lettuce"); `product` stays verbatim
   on the record. Generation lands in step 7 with the rest of the voice work;
   the field, the fallback and the never-alone rule are in place from step 3.
   See §2.1 for the three rules that keep the generalization honest.
7. **Pet food on the openFDA path.** Now moot in practice — the captured window
   contained none, and RSS items carry a structured `Product Type` that
   identifies them. But openFDA offers no equivalent field, so if a pet-food row
   ever does appear there, nothing filters it. Revisit at step 3 if it bites.
