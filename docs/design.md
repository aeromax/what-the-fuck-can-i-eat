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

A single static page listing US food recalls and alerts from the past 30 days.

"Past 30 days" is the claim, not "currently active", and the page says so in
those words. Nothing in the pipeline re-verifies that a recall is still open, and
for openFDA the window runs on the day FDA *reported* the recall rather than the
day the public was told — see §10 q3, which is the reasoning behind the
user-facing wording. Claiming live status would be a factual claim the data does
not support.

"Alerts" is in that sentence deliberately: FSIS Public Health Alerts are included
by the inclusion rule and **a PHA is not a recall** (§7). A description that says
only "recalls" mislabels part of the list.

Each row is a food name in large plain type, and beneath it one factual line
naming the brand, the stores, the states, the country of origin, and the lot
codes to avoid.

The voice is snarky. The avoid-line is not.

There is no server, no database, and no model call at request time. The page is
static HTML; the data behind it is a JSON file committed to git, refreshed once
a day by a scheduled GitHub Action (`.github/workflows/refresh.yml`, written at
step 10 and first run on GitHub on 2026-09-01 — run 33539857201, which committed
`bd9f427` and dispatched the deploy 18 seconds later).

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
   **Relaxed 2026-08-31 — see "Relaxation" below. This rule no longer holds for
   the collapsed row.**
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

### Relaxation of rule 1 (2026-08-31)

**Rule 1 was relaxed at the user's explicit direction.** `product` moved behind
the row's disclosure control. The collapsed row now identifies an item by
`displayName` alone, beside the snark headline, the plain-English severity label
and the announcement date. `product` is one interaction away rather than always
on screen.

This is recorded rather than argued, because it is a product decision the user
made with the tradeoff in front of them — but the tradeoff is stated here so
nobody has to rediscover it.

**The residual risk.** A reader who never expands a row sees only a
model-written category name. That is precisely the generalization hazard this
section was written about: one recalled brand of eggs presented as "eggs". The
mitigation that rule 1 provided — the specific thing being unavoidably visible
next to the general name — is gone for that reader.

**What still holds, and is not negotiable:**

- `product` is **always in the DOM** and always rendered in the expanded body.
  It is hidden by a disclosure control, not omitted, not truncated, and not
  summarised. Every row is one tap from the verbatim text.
- `product` remains **verbatim government text and never model-written**. Rules
  2 and 3 above are untouched, as is everything in §2.
- The expanded body leads with `product`, directly above the `avoidLine`, so
  the first thing a reader who opens a row sees is which product this is.
- `displayName` stays nullable, and a null still falls back to `product` in the
  large type. A missing generation still costs legibility, never facts.

If this page ever grows a second surface — a feed, a share card, an embed —
this relaxation does **not** travel with it by default. It was granted for the
collapsed row of the main list, where a disclosure control is present and
obvious. Re-ask before applying it anywhere a reader cannot expand.

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
| `mergedFrom` | ids and citations of records folded in by merge.ts, so no citation is lost |
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
- **A zero-match query answers HTTP 404 with an error body**, not 200 with an
  empty `results` array. Verified live 2026-08-31:
  `{"error":{"code":"NOT_FOUND","message":"No matches found!"}}`. Reporting that
  as `reachable: false` would be two lies at once — the footer would say openFDA
  was down when it answered, and refresh's loud "reachable but returned zero"
  warning (§4) would be skipped, since the zero arrived by the network-failure
  route instead. `fetchOpenFda` therefore treats a 404 **whose body parses with
  `error.code === "NOT_FOUND"`** as reachable-and-empty, and every other non-OK
  status as unreachable. The body check is not defensive politeness: a
  wrong-but-plausible URL 404s as well, and FDA serves a plausible page for one.
  An empty window is an ordinary state here, not an alarm — `report_date` lags
  recall initiation by a median of 69 days.
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
- ⚠️ **The feed returned HTTP 404 from a GitHub Actions runner while returning
  200 locally (2026-09-01).** The first real `refresh.yml` run (33539857201)
  wrote FDA RSS `reachable: false`, note `"HTTP 404"`, count 0 into
  `data/meta.json`, with openFDA (40 rows) and FSIS (7 records) both reachable in
  the same run. Minutes later the identical URL returned HTTP 200,
  `application/rss+xml`, 18,541 bytes from the developer's machine. This is the
  same shape as the FSIS block above — works locally, blocked from CI — on a
  source that had never shown it. **The consequence is specific and severe: the
  RSS feed is the only entrance to the `extracted` tier**, because press releases
  are reached through it, so a 404 here silently removes every prose-sourced
  record from the page. Record count fell from 64 to 47 and the page went 100%
  `verified`. Degrade-never-blank held and the footer named the source
  unreachable, which is the only reason this was visible at all.
- **Resolved the same day: use `impit` for `www.fda.gov`.** Probe run 33543434214
  measured both transports from a runner. Plain `fetch()` got 404, no
  content-type, a 10-byte `Not found\n` body — on the feed and on a press-release
  page alike — while `impit` got 200 with 18,496 bytes of `application/rss+xml`
  and a 49,882-byte HTML page respectively. That body is not FDA's not-found
  page; it is an edge rule keyed on the client. Both call sites
  (`scripts/sources/fdaRss.ts`, `scripts/pressRelease.ts`) now use `impit`;
  openFDA is a different host and stays on `fetch()`. Refresh run 33543764413
  published 64 records with all three sources reachable. Note the feed's
  `<link>` is `http://` and `fetchPressRelease` rewrites it to `https://` — probe
  the URL production sends, or the result is meaningless.
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
  already walked.
- ⚠️ **The block reproduces from a GitHub runner, which settles the ambiguity
  above (2026-09-01).** `source-probe.yml` run 33552899369 ran both transports
  against the API in one job from a runner: `impit` returned HTTP 200 and
  12,948,541 bytes (2,023 records, 7 after the inclusion rule); plain `fetch()`
  returned **HTTP 403, `text/html`, a 410-byte Akamai `Access Denied` body**.
  Of the three explanations offered above — lifted, IP-dependent, intermittent —
  this rules out "lifted". The block is on; the author's machine is simply not
  subject to it. Every local non-reproduction was a fact about that IP.
- **`impit` reaches FSIS from a GitHub Actions runner (2026-09-01).** The first
  real `refresh.yml` run (33539857201) called the production `fetchFsis()` on a
  GitHub-hosted runner and wrote FSIS `reachable: true`, `"7 of 2023 records
  included"` into `data/meta.json` — the same record counts the local run sees.
  This was the last open half of build plan step 5. The probe built to answer it
  was never dispatched; its legs now live in
  `.github/workflows/source-probe.yml`, kept as the isolated diagnostic if FSIS
  is ever blocked in future.
- **`field_active_notice` is not the recency filter.** Across all 2,023 live
  records exactly **one** is `"True"` (1,833 `"False"`, 189 empty). Filtering on
  it publishes a one-item page. Recency must come from `field_recall_date`,
  which is ISO `YYYY-MM-DD` — unlike openFDA's `YYYYMMDD`.
- `field_recall_classification` carries a fourth value outside the Class scheme:
  **`Public Health Alert`** (170 of 2,023; 2 of the 9 in the last 30 days). See
  §7 and open question 5.
- Every recall appears **twice**, once per `langcode`. Filter to `English` or the
  page double-counts every meat recall.
- **`field_states` is not only states.** A nationwide recall carries the literal
  string `"Nationwide"` in that array, which a name-matching filter silently
  drops — turning a nationwide public health alert into a record affecting
  nowhere, and an empty state list reads as "not near me". 3 of 8 live records
  in the window are nationwide.
- **`field_establishment` is populated on well under half of records** (5 of 12
  in the captured window), so it is not a reliable company column. Empty is
  honest; parsing the company out of `field_title` would be inference.
- **`field_product_items` is empty on Public Health Alerts**, which list their
  products on a linked page. `field_title` is the fallback.
- **FSIS publishes no lot codes.** `field_labels` holds a PDF filename
  (`Recall-018-2026-Labels.pdf`), not codes; the codes are inside the
  `field_product_items` prose, which is kept verbatim in `product`. So the
  design's claim that FSIS is "fully structured" is true of class, date, states
  and reason — but not of lot codes.
- Plain-text fields carry HTML entities (`Bea&#039;s Best`). Decode on the way in.
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
src/recall.ts               the Recall type and its Zod schema
src/severity.ts             class -> plain-English hazard, per agency (§7)
src/dates.ts                US Eastern formatting, EDT/EST per date (§7)
src/meta.ts                 reads data/meta.json for the footer
data/recalls.json           published state, committed to git
data/review.json            ambiguous merges needing a human look
data/meta.json              last-checked time + which sources were reachable
data/snapshots/             raw API responses, OVERWRITTEN each run
scripts/sources/*.ts        openfda | fdaRss | fsis (via impit)
scripts/sourceSchemas.ts    Zod shapes for the three raw upstream responses
scripts/pressRelease.ts     fetch + <dl> parse of one FDA announcement
scripts/normalize.ts        source rows -> Recall
scripts/states.ts           distribution text -> state codes
scripts/merge.ts            dedupe + upgrade extracted -> verified
scripts/gemini.ts           Gemini transport + JSON-Schema keyword allowlist
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

**FSIS snapshots the selected records, not the raw response** (decided at step 5).
The full feed is 12.9 MB of 2,023 records, almost all of them years old and
irrelevant; committing it on every change would add gigabytes of git history a
year — the same cost the "no timestamped files" rule exists to avoid. The
selected subset is 38 KB and answers the audit question completely for
everything actually published. openFDA and RSS are small enough to snapshot
whole.

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
- **A run that changes nothing must not commit.** Most daily runs
  find no news. Exit early when output is byte-identical to what is committed,
  or the repo accrues an empty commit every day forever.
- **Snapshots overwrite in place.**
- **Ambiguous merges never merge.** A duplicate row is a cheap, visible failure —
  a reader sees the same recall twice and is mildly annoyed. A wrong merge
  attaches the wrong lot codes to the wrong product, which is the one failure
  mode in this system that could actually hurt someone. Ambiguous cases go to
  `data/review.json` with both entries left visible on the page.

The asymmetry in that last rule is the design's whole posture in miniature:
when uncertain, be redundant rather than confident.

### 6.1 How merge decides (step 6, 2026-08-30)

`scripts/merge.ts` compares every cross-source pair and returns one of three
verdicts. No model is involved: merging is a judgement about record identity made
from government fields, and a confidently wrong merge is exactly the failure the
AI/facts boundary exists to prevent.

**Hard gates** — failing any of these is `unrelated`, with nothing for a human to
adjudicate:

- **Same source never merges.** One agency filing two rows means two recalls.
  Clover Hill Dairy alone filed 18 near-identical cheese rows in one window.
- **Conflicting non-null classifications never merge.** Null is not a conflict —
  it only ever means "FDA has not graded this yet".
- **No company on either side, no match.** FSIS leaves `field_establishment`
  empty on most records, so meat recalls essentially never match — correctly,
  since openFDA does not cover meat.
- **Announcement dates more than 300 days apart never merge.** The gate is
  generous on purpose: openFDA's reporting lag reaches 196 days, so anything
  tighter would reject genuine upgrades.

**Confirmation** — past the gates, the company is effectively certain, and the
only remaining question is *same recall, or two recalls from one firm?* Only
**product agreement** can answer it:

- Product Jaccard ≥ 0.5 over distinctive tokens, with at least 2 words in common.
- Or a brand match with product ≥ 0.35.
- Or a shared lot code with product ≥ 0.35.

Anything else is `ambiguous`: both records stay published and the pair is written
to `review.json` for a human.

Three findings from live data shaped this, each of which had produced a wrong
merge in an earlier draft:

- **A shared lot code does not mean a shared product.** Clover Hill Dairy prints
  one code, `AA051526`, across all 18 recalled products. Letting a lot code
  confirm a match on its own fused two unrelated cheeses. Lot codes now only
  corroborate.
- **Company names inside product text inflate similarity.** Every Clover Hill row
  begins "Clover Hill Dairy LLP, …", scoring two unrelated cheeses at 0.56 —
  above the threshold — on shared company words alone. Company and brand tokens
  are now stripped before comparison.
- **openFDA boilerplate inflates it further.** "Unknown information regarding
  packaging/labeling. Approximate total quantity…" repeats verbatim on every row
  a firm files, and supplied 7 of 11 apparently-shared words between those same
  two cheeses. It is now treated as noise.

**On merging**, the verified record wins every factual field, `headline`,
`avoidLine` and `displayName` are carried across so voice is never regenerated
(§6), the earliest announcement date survives (§10.3), and every merged-away
record's citation is preserved in `mergedFrom` — §2 requires a reader to be able
to check the page a fact came from, and after a merge the record came from more
than one.

## 7. Inclusion rule

Status `Ongoing`, Class I and Class II, **plus FSIS Public Health Alerts**,
announced within 30 days.

Class III is excluded as the boring tier. Human food only; the feed also carries
pet food, which is filtered out.

**How many items that yields is not a property of the rule.** It is whatever the
three agencies published into the trailing window, and it moves at every refresh.
Observations, each true only on its date: ~46 at the time of design (2026-08-28);
**64 on 2026-09-01** — 40 openFDA, 17 RSS, 7 FSIS, of which exactly 1 was a PHA.
Any count written down anywhere must be labelled as an observation on a named
date. The page never hard-codes one; it counts the records it is rendering.

Nor is the window a live-status check: inclusion is decided once, at fetch time,
from the announcement (or, for openFDA, report) date, and nothing afterwards
re-asks whether the recall is still open. See §1 and §10 q3.

This is an **editorial judgment, not a technical constraint**. Changing it is a
product decision — ask, don't assume.

### Unclassified records (decision 2026-08-29)

**Confirmed: include them.** FDA press releases carry **no
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

### Plain-English severity (decision 2026-08-29)

The page never prints "Class I". Class numbers mean nothing to someone holding a
jar, and the whole point of the page is a four-second read. Each class is shown
as the hazard it describes:

| Stored value | Shown as |
|---|---|
| `Class I` | Can cause serious illness or death |
| `Class II` (FDA) | Can cause temporary or reversible illness |
| `Class II` (FSIS) | Remote chance of illness |
| `Public Health Alert` | Warning — not recalled, may still be on sale |
| `null` | Severity not yet assigned by FDA |

Implemented in `src/severity.ts`. Three properties keep this inside the AI/facts
boundary rather than eroding it:

- It is a **fixed legend**, written and reviewed once, applied by lookup on a
  government-supplied class. Nothing is inferred per record and no model is
  involved, so this is not the model writing a factual field.
- The issuing agency's **verbatim definition travels with every label** (the
  badge's `title`), so the shortening is checkable against the source.
- **FDA and FSIS word their definitions differently and are not interchangeable.**
  `severityOf` picks by `source`; attributing FDA's text to an FSIS record would
  be a misquote. Sources fetched 2026-08-29: FDA's *Recalls, Background and
  Definitions* page, and the "USDA Recall Classifications" block FSIS prints on
  every recall page.

### Dates (decision 2026-08-29)

All dates are US Eastern and labelled with the zone, because every source is a
US agency publishing on Eastern time and an unlabelled date invites the reader to
assume their own.

The zone abbreviation is computed per date rather than fixed: `EDT` from March to
November, `EST` otherwise. Pinning a literal UTC-5 year-round would be wrong for
about eight months and wrong in a way that **moves calendar dates** — a recall
announced at 00:30 EDT would render as the previous day. That is the same
off-by-one the `<time datetime>` UTC bug already caused once, and since
`announcedDate` drives the 30-day window, a shifted date can add or drop an item.
See `src/dates.ts`.

### Unclassified openFDA rows (extended 2026-08-30, step 6)

The "include unclassified" ruling was originally made about RSS records, but
openFDA has the same state under its own name: `Not Yet Classified`. Excluding it
there while including it here would have been an inconsistency rather than a
policy, so `selectRows` now admits it and normalization maps it to
`classification: null` like every other ungraded record. It adds one live record
(a Taylor Farms lettuce blend, `Ongoing`).

That row also exposed a latent crash. **`recall_number` is empty on ungraded
rows**, and `makeId` throws on an empty key by design. `event_id` is not a safe
substitute — it groups related recalls and is shared by 21 of 43 rows in the
captured window, so keying on it would fuse two different products into one
record: exactly the wrong-merge failure §6 exists to prevent. The fallback key is
therefore `event-<event_id>-<sha1(product_description)[0:8]>`, which is stable
across runs and distinct per product. The citation falls back to an `event_id`
query so it still resolves.

### Public Health Alerts (decision 2026-08-29)

FSIS emits a fourth `field_recall_classification` value that is not a recall
class: `Public Health Alert`. FSIS issues one when contaminated product is
believed to be in commerce **but no recall has been requested** — often because
the producer cannot be identified or will not act.

They are included. The rule as originally written (Class I and II) would have
dropped them silently, and by this page's own standard — food you should not eat
right now — a PHA is at least as urgent as a Class II, precisely because nothing
has been withdrawn from shelves. Their share of the FSIS feed moves like every
other count here: 2 of the 9 items in the window captured on 2026-08-29, 1 of 7
on 2026-09-01. A frequency observed twice is not a planning constant.

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

- **Node ≥22.12.0.** Astro 7.2.9 declares `node: ">=22.12.0"` and nothing
  stricter. **Corrected:** the "even-numbered only" clause recorded here was
  wrong, and `CLAUDE.md`'s verified-environment section is the standing record.
  The local machine has since moved to **v25.9.0** (odd) and `install`, `build`,
  `check` and `test` all pass on it. Treat odd releases as
  working-but-unsupported: they are not an LTS line, so **pin CI to an even
  release** (22 or 24) rather than matching the local version. `static.yml` and
  `refresh.yml` both use Node 24.
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
- **No built-in Zod support.** The guidance previously recorded here was wrong
  and dangerous; corrected 2026-08-30 against `zod@4.5.1`. `z.toJSONSchema()`
  attaches `~standard` as a non-enumerable, non-configurable own property, so
  `JSON.stringify` already omits it and `delete` throws `TypeError` in strict
  mode. Sanitise by structural round-trip.
  The real hazard is Gemini's keyword allowlist: `z.toJSONSchema` emits
  `$schema`, `minLength`, `default`, `const` and `maxLength` for schemas already
  in `src/recall.ts` (`.min(1)`, `.default([])`). A targeted strip of `~standard`
  would still have sent rejected keywords. Filter to the allowlist and convert
  `const` into a single-valued `enum`.
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
2. ~~**Merge ambiguity threshold.**~~ **Resolved 2026-08-30 (step 6).** Company
   equality is a hard gate; product agreement is the only thing that can confirm
   a match. Reason agreement and lot codes corroborate but can never confirm on
   their own. Same company + unclear product = ambiguous, not matched. See
   §6.1 and `scripts/merge.ts`.
3. ~~**The 30-day clock.**~~ **Resolved 2026-08-30 (step 6): the earliest known
   announcement date wins a merge, and the window is never re-applied after
   merging.**

   openFDA's `announcedDate` is `report_date` — the day FDA published the
   enforcement report, not the day the public was told. Measured on live data it
   lags `recall_initiation_date` by a **median of 69 days** (min 14, max 196), so
   it is a poor announcement date and the press-release date is the true one.
   Taking the earliest of a merged group therefore makes the date on the page
   more honest, not less.

   The worry was that an older date could push a record out of the 30-day window
   — an item vanishing *because* better data arrived. It cannot, because
   **inclusion is decided per source at fetch time, before merging, and
   `mergeRecalls` never re-applies the window.** A record is on the page because
   at least one source considered it current; merging only improves what is
   known about it.

   A consequence worth stating plainly: for openFDA the inclusion rule is really
   "reported within 30 days", not "announced within 30 days". It cannot be
   otherwise — no openFDA record in the live window has an initiation date within
   30 days, so an announcement-date window would drop the entire verified tier.
   The page therefore mixes "recently announced" (RSS, FSIS) with "recently
   reported" (openFDA). That is an editorial wrinkle, not a bug, but it is real.

   **Extended 2026-09-01: this wrinkle is now the stated reason for the page's
   own wording, not a loose end.** Because the window is per-source, applied once
   at fetch time and never re-asked, the list is "what the agencies put into the
   trailing 30 days", not "what is open right now" — nothing anywhere in the
   pipeline re-verifies that a recall is still live. So the page describes its
   contents as **"existing recalls and alerts, past 30 days"** (the header count
   block and the `<meta name="description">`), and §1 says the same. The earlier
   phrasing, "recalls that are currently active", asserted a live-status check
   this project does not perform. Whether it should perform one is a separate
   product question; until it does, the wording has to match the data.

4. ~~**Deploy target.**~~ **Resolved 2026-09-01 (step 10): GitHub Pages, from
   `.github/workflows/static.yml`.** It type-checks, tests, builds, greps `dist/`
   for a credential-shaped string, and deploys — the verification runs before the
   deploy because a page that is wrong about food recalls is worse than a page
   that is a few minutes stale.

   It triggers on push to `main` and on `workflow_dispatch`. The refresh path has
   to use the second one: a push made with the default `GITHUB_TOKEN` does not
   start another workflow run, so the data commit alone would land without ever
   rebuilding the site. `.github/workflows/refresh.yml` therefore ends by
   dispatching `static.yml` explicitly, which needs no change to `static.yml` and
   no new secret — the reason it was preferred to a PAT or to `workflow_call`.
   See build plan step 10 and the `CLAUDE.md` trap.

   **Proven in production 2026-09-01.** Refresh run 33539857201 committed
   `bd9f427` and dispatched `static.yml`; deploy run 33539886920 started 18
   seconds later as a `workflow_dispatch`, not as a `push`. The commit alone
   started nothing, exactly as the non-recursion rule predicts. The same deploy
   run executed `static.yml`'s `dist/` credential grep on a runner with
   `GEMINI_API_KEY` present and passed, which is the other half of step 10's
   acceptance criteria.
5. ~~**FSIS `Public Health Alert`.**~~ **Resolved 2026-08-29: include them**, as
   the safer reading. Step 5 no longer blocked. The remaining presentational work
   landed with step 9 (2026-08-31): a PHA is not labelled a recall — its severity
   label reads "Warning — not recalled, may still be on sale", in words, in the
   collapsed row. The page's own description of its contents says "recalls **and
   alerts**" for the same reason. See §7 and build plan step 9.
6. ~~**`product` is not a food name on the openFDA path.**~~ **Resolved
   2026-08-29: a model-written `displayName`.** The large type gets a short
   common food name ("eggs", "ground beef", "lettuce"); `product` stays verbatim
   on the record. Generation landed in step 7 with the rest of the voice work;
   the field and the fallback have been in place since step 3. See §2.1 for the
   three rules that keep the generalization honest — and for the 2026-08-31
   relaxation of the never-alone rule, which no longer holds for the collapsed
   row.
7. **Pet food on the openFDA path.** Now moot in practice — the captured window
   contained none, and RSS items carry a structured `Product Type` that
   identifies them. But openFDA offers no equivalent field, so if a pet-food row
   ever does appear there, nothing filters it. Revisit at step 3 if it bites.
