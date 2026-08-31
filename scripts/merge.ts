import { z } from 'zod';
import { RecallSchema, type Recall } from '../src/recall.ts';

// Cross-source dedupe and the extracted -> verified upgrade.
//
// The rule that dominates this file (docs/design.md §6):
//
//   Ambiguous merges never merge.
//
// A duplicate row is a cheap, visible failure — a reader sees the same recall
// twice and is mildly annoyed. A wrong merge attaches the wrong lot codes to the
// wrong product, which is the one failure mode in this system that could
// actually hurt someone. Every threshold below is therefore tuned to
// over-produce review entries. When uncertain, be redundant rather than
// confident.
//
// No model is involved anywhere in this file. Merging is a decision about
// record identity made from government fields, and a wrong merge is exactly the
// kind of confident-sounding error the AI/facts boundary exists to prevent.

// --- text normalisation -------------------------------------------------------

/**
 * Company suffixes and filler that carry no identifying information. Stripping
 * them lets "Kettle Cuisine, LLC" and "Kettle Cuisine" compare equal.
 */
const COMPANY_NOISE =
  /\b(llc|l\.l\.c|inc|incorporated|ltd|limited|corp|corporation|co|company|companies|the|group|holdings|brands|usa|us|international|intl)\b/g;

const PRODUCT_NOISE = new Set(
  (
    'the and for with from that this are was were has have not all any our its ' +
    'net wt oz lbs lb kg gram grams containing contains container containers ' +
    'package packages packaged packing packed pack cases case box boxes bag bags ' +
    'bottle bottles jar jars cup cups pouch pouches carton cartons tray trays ' +
    'plastic clear glass foil paper label labels item items unit units size sizes ' +
    'sold under following such more product products including include includes ' +
    'upc sku code codes lot lots date dates keep refrigerated frozen fresh ' +
    'distributed distribution retail sells sell store stores approximately ' +
    // openFDA boilerplate for missing data, repeated verbatim across every row a
    // firm files. On the 18 Clover Hill Dairy rows this phrase alone supplied 7
    // of the 11 "shared" tokens between two unrelated cheeses.
    'approximate unknown information regarding packaging labeling label total ' +
    'quantity quantities variety varieties assorted assortment style styles ' +
    'brand brands name names description descriptions'
  ).split(/\s+/),
);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function companyKey(value: string): string {
  return words(value).join(' ').replace(COMPANY_NOISE, ' ').replace(/\s+/g, ' ').trim();
}

function contentTokens(value: string): Set<string> {
  return new Set(words(value).filter((w) => w.length > 3 && !PRODUCT_NOISE.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** How much of the smaller token set is contained in the larger. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Lot codes are the strongest identity signal available, because they are
 * specific strings printed on a package. openFDA stores them as free-text prose
 * though (docs/design.md §4), so codes are pulled out of whatever text is there
 * rather than compared whole.
 */
function lotCodeTokens(recall: Recall): Set<string> {
  const out = new Set<string>();
  for (const raw of recall.lotCodes) {
    for (const token of raw.toUpperCase().split(/[^A-Z0-9/-]+/)) {
      // A code needs digits and length to be distinctive. "LOT" and "2026" are
      // not identifying; "TFMX183A05" and "099482502065" are.
      if (token.length >= 5 && /\d/.test(token) && !/^(19|20)\d{2}$/.test(token)) {
        out.add(token);
      }
    }
  }
  return out;
}

// --- scoring ------------------------------------------------------------------

export interface MatchScores {
  company: number;
  product: number;
  reason: number;
  /** Number of distinctive lot-code tokens the two records share. */
  sharedLotCodes: number;
  /** Distinctive product words in common. Guards against tiny-set Jaccard flukes. */
  sharedProductTokens: number;
  brandMatch: boolean;
}

/**
 * Product tokens with the company's own name removed.
 *
 * Every Clover Hill Dairy row begins "Clover Hill Dairy LLP, ...", so comparing
 * raw product text scores two of their unrelated cheeses at 0.56 — over the
 * confirm threshold — on shared company words alone. Once the pair is already
 * gated on company equality, that text carries exactly zero identity
 * information, and leaving it in makes every same-firm pair look alike.
 */
function distinctiveProductTokens(recall: Recall): Set<string> {
  const noise = new Set(companyKey(`${recall.company} ${recall.brand}`).split(' ').filter(Boolean));
  const tokens = contentTokens(recall.product);
  for (const token of noise) tokens.delete(token);
  return tokens;
}

export function scorePair(a: Recall, b: Recall): MatchScores {
  const companyA = companyKey(a.company);
  const companyB = companyKey(b.company);
  const company =
    companyA === '' || companyB === ''
      ? 0
      : companyA === companyB
        ? 1
        : containment(new Set(companyA.split(' ')), new Set(companyB.split(' ')));

  const lotsA = lotCodeTokens(a);
  const lotsB = lotCodeTokens(b);
  let sharedLotCodes = 0;
  for (const code of lotsA) if (lotsB.has(code)) sharedLotCodes += 1;

  const brandA = companyKey(a.brand);
  const brandB = companyKey(b.brand);

  const productA = distinctiveProductTokens(a);
  const productB = distinctiveProductTokens(b);
  let sharedProductTokens = 0;
  for (const token of productA) if (productB.has(token)) sharedProductTokens += 1;

  return {
    company,
    product: jaccard(productA, productB),
    sharedProductTokens,
    reason: jaccard(contentTokens(a.reason), contentTokens(b.reason)),
    sharedLotCodes,
    brandMatch: brandA !== '' && brandA === brandB,
  };
}

// --- the decision -------------------------------------------------------------

export type Verdict = 'merge' | 'ambiguous' | 'unrelated';

/** Company evidence below this is treated as no evidence of shared identity. */
const COMPANY_FLOOR = 0.6;
/** Product agreement at or above this is strong enough to confirm a match. */
const PRODUCT_CONFIRM = 0.5;
/** With a corroborating signal, slightly weaker product agreement is admissible. */
const PRODUCT_WITH_CORROBORATION = 0.35;
/** Below this, the two records are describing different hazards. */
const REASON_CONTRADICTION = 0.15;
/**
 * openFDA's report_date lags the announcement by a median of 69 days and up to
 * 196 in observed data, so the gate has to be generous or it would reject every
 * genuine upgrade. It exists only to stop a company matching itself across
 * unrelated years.
 */
const MAX_DATE_GAP_DAYS = 300;
/** Minimum distinctive product words in common before any match is credible. */
const MIN_SHARED_PRODUCT_TOKENS = 2;

function daysApart(a: Recall, b: Recall): number {
  const at = new Date(`${a.announcedDate}T12:00:00Z`).getTime();
  const bt = new Date(`${b.announcedDate}T12:00:00Z`).getTime();
  if (Number.isNaN(at) || Number.isNaN(bt)) return Number.POSITIVE_INFINITY;
  return Math.abs(at - bt) / 864e5;
}

export interface PairVerdict {
  verdict: Verdict;
  scores: MatchScores;
  /** Human-readable justification, written into review.json. */
  why: string;
}

export function judgePair(a: Recall, b: Recall): PairVerdict {
  const scores = scorePair(a, b);

  // --- hard gates. A failure here is "unrelated", never "ambiguous", because
  // --- there is nothing for a human to adjudicate.

  // Two rows from one source are two distinct recalls that agency chose to file
  // separately. Clover Hill Dairy alone files 18 near-identical cheese rows.
  if (a.source === b.source) {
    return { verdict: 'unrelated', scores, why: 'same source' };
  }

  // Different agencies grading the same recall differently is possible, but
  // Class I against Class II is more likely two different recalls.
  if (a.classification !== null && b.classification !== null && a.classification !== b.classification) {
    return { verdict: 'unrelated', scores, why: 'conflicting classifications' };
  }

  if (daysApart(a, b) > MAX_DATE_GAP_DAYS) {
    return { verdict: 'unrelated', scores, why: 'announcement dates too far apart' };
  }

  // Without a company on both sides there is no identity anchor at all. FSIS
  // leaves field_establishment empty on most records, so this is the usual
  // outcome for meat recalls — correctly, since openFDA does not cover meat.
  if (scores.company === 0) {
    return { verdict: 'unrelated', scores, why: 'no company on one or both records' };
  }
  if (scores.company < COMPANY_FLOOR) {
    return { verdict: 'unrelated', scores, why: 'different companies' };
  }

  // --- same company, near-certainly. Now: same RECALL, or two recalls from one
  // --- firm? Getting this wrong is the dangerous direction.

  // Two short product names sharing one word score deceptively high on Jaccard.
  // Requiring a couple of real words in common costs nothing on genuine matches
  // and sends the flukes to review instead.
  const enoughOverlap = scores.sharedProductTokens >= MIN_SHARED_PRODUCT_TOKENS;
  const productConfirms = enoughOverlap && scores.product >= PRODUCT_CONFIRM;
  const brandConfirms =
    enoughOverlap && scores.brandMatch && scores.product >= PRODUCT_WITH_CORROBORATION;

  // A shared lot code CANNOT confirm a match on its own, which an earlier
  // version of this file allowed. Clover Hill Dairy prints one code, AA051526,
  // across all 18 of its recalled products — so "same lot code" there means
  // "same firm", not "same product". Lot codes only corroborate an already
  // plausible product match.
  const lotCorroborates =
    enoughOverlap && scores.sharedLotCodes > 0 && scores.product >= PRODUCT_WITH_CORROBORATION;

  const confirmed = productConfirms || brandConfirms || lotCorroborates;

  if (!confirmed) {
    return {
      verdict: 'ambiguous',
      scores,
      why: 'same company but the products do not clearly match',
    };
  }

  // A corroborated lot code outranks a reason mismatch — the same physical
  // package can be recalled for more than one stated reason.
  if (!lotCorroborates && scores.reason < REASON_CONTRADICTION) {
    return {
      verdict: 'ambiguous',
      scores,
      why: 'products look similar but the stated reasons disagree',
    };
  }

  return { verdict: 'merge', scores, why: 'company, product and reason all agree' };
}

// --- merging ------------------------------------------------------------------

/**
 * Source precedence when several records survive into one.
 *
 * `verified` always outranks `extracted` — that is the whole point of the
 * upgrade. Between two verified records the order is arbitrary but must be
 * STABLE, or the same input would produce different output between runs and the
 * "a run that changes nothing must not commit" rule would never hold.
 */
const SOURCE_RANK: Record<string, number> = { openfda: 0, fsis: 1, fdaRss: 2 };

function preferenceOrder(group: Recall[]): Recall[] {
  return [...group].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'verified' ? -1 : 1;
    const rank = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    return rank !== 0 ? rank : a.id.localeCompare(b.id);
  });
}

/** First non-null value in preference order — used to carry voice across. */
function firstPresent(group: Recall[], pick: (r: Recall) => string | null): string | null {
  for (const recall of group) {
    const value = pick(recall);
    if (value !== null && value !== '') return value;
  }
  return null;
}

export function mergeGroup(group: Recall[]): Recall {
  const ordered = preferenceOrder(group);
  const winner = ordered[0]!;
  if (ordered.length === 1) return winner;

  const rest = ordered.slice(1);

  return {
    ...winner,

    // The earliest known announcement is the true one. See docs/design.md §10.3:
    // openFDA's date is report_date, which is when FDA published the enforcement
    // report, not when the public was told. Taking the earliest keeps the date on
    // the page honest. This never removes an item, because the 30-day window is
    // applied per source BEFORE merging and is not re-applied here.
    announcedDate: ordered
      .map((r) => r.announcedDate)
      .reduce((earliest, d) => (d < earliest ? d : earliest)),

    // A classification from any source beats null, since null only ever means
    // "FDA has not graded this yet".
    classification: winner.classification ?? firstPresentClass(ordered),

    // Voice is carried across rather than regenerated (docs/design.md §6). This
    // is load-bearing: the merged record keeps the winner's id, so without this
    // voice.ts would see an id with no headline and pay to write it again — and
    // the page's voice would change under the reader for no reason.
    displayName: firstPresent(ordered, (r) => r.displayName),
    headline: firstPresent(ordered, (r) => r.headline),
    avoidLine: firstPresent(ordered, (r) => r.avoidLine),

    // Every merged-away record keeps its citation. Design §2 requires a reader
    // to be able to check the government page a fact came from, and after a
    // merge the record came from more than one.
    mergedFrom: [
      ...winner.mergedFrom,
      ...rest.map((r) => ({ id: r.id, source: r.source, sourceUrl: r.sourceUrl })),
    ],
  };
}

function firstPresentClass(group: Recall[]): Recall['classification'] {
  for (const recall of group) if (recall.classification !== null) return recall.classification;
  return null;
}

// --- the pass -----------------------------------------------------------------

export interface ReviewEntry {
  why: string;
  scores: MatchScores;
  records: Recall[];
}

/**
 * Runtime schema for a review-file entry. Kept alongside `ReviewEntry` so the
 * static type and the parsed shape can never drift. The page validates
 * `data/review.json` against `z.array(ReviewEntrySchema)` on the way in — a
 * malformed file should fail the build rather than render half a page.
 */
export const MatchScoresSchema = z.object({
  company: z.number(),
  product: z.number(),
  reason: z.number(),
  sharedLotCodes: z.number(),
  sharedProductTokens: z.number(),
  brandMatch: z.boolean(),
});

export const ReviewEntrySchema = z.object({
  why: z.string(),
  scores: MatchScoresSchema,
  records: z.array(RecallSchema).length(2),
});

export interface MergeResult {
  /** Deduped records, newest announcement first. Ambiguous pairs stay separate. */
  recalls: Recall[];
  /** Pairs a human should look at. Both records are still in `recalls`. */
  review: ReviewEntry[];
  mergedCount: number;
}

export function mergeRecalls(input: Recall[]): MergeResult {
  // Union-find over confirmed matches only.
  const parent = input.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };

  const ambiguous: Array<{ i: number; j: number; verdict: PairVerdict }> = [];

  for (let i = 0; i < input.length; i += 1) {
    for (let j = i + 1; j < input.length; j += 1) {
      const verdict = judgePair(input[i]!, input[j]!);
      if (verdict.verdict === 'merge') union(i, j);
      else if (verdict.verdict === 'ambiguous') ambiguous.push({ i, j, verdict });
    }
  }

  const groups = new Map<number, Recall[]>();
  input.forEach((recall, i) => {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(recall);
    else groups.set(root, [recall]);
  });

  const recalls = [...groups.values()].map(mergeGroup);
  const mergedCount = input.length - recalls.length;

  // An ambiguity between two records that ended up merged anyway (via a third,
  // confidently-matched record) is no longer a question for a human.
  const review: ReviewEntry[] = ambiguous
    .filter(({ i, j }) => find(i) !== find(j))
    .map(({ i, j, verdict }) => ({
      why: verdict.why,
      scores: verdict.scores,
      records: [input[i]!, input[j]!],
    }));

  recalls.sort((a, b) =>
    a.announcedDate === b.announcedDate
      ? a.id.localeCompare(b.id)
      : b.announcedDate.localeCompare(a.announcedDate),
  );

  return { recalls, review, mergedCount };
}
