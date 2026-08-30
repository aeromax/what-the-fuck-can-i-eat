import type { z } from 'zod';
import { type Recall, RecallSchema, makeId, slugFromUrl } from '../src/recall.ts';
import type { PressReleaseFactsT } from './pressRelease.ts';
import type { FsisRecord, OpenFdaRow } from './sourceSchemas.ts';
import { normalizeStateNames, parseDistribution } from './states.ts';

type OpenFdaRowT = z.infer<typeof OpenFdaRow>;

/** openFDA emits YYYYMMDD strings. The model stores ISO. */
export function isoFromCompact(yyyymmdd: string): string {
  const m = yyyymmdd.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) throw new Error(`isoFromCompact: not a YYYYMMDD date: ${yyyymmdd}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * openFDA has no press-release URL, so the citation is the API query that
 * returns exactly this record. It is deterministic, public, and a reader can
 * paste it into a browser and see the same row this page was built from.
 */
export function openFdaSourceUrl(recallNumber: string): string {
  const q = encodeURIComponent(`recall_number:"${recallNumber}"`);
  return `https://api.fda.gov/food/enforcement.json?search=${q}`;
}

/**
 * openFDA's `code_info` is a structured *field* with free-text *content*. Some
 * rows are a bare lot code ("Selec1011"); others are a paragraph explaining
 * where on the carton to look. Splitting that prose into a list would invent
 * lot codes that do not exist, so it is kept whole and verbatim.
 *
 * "None" is the government's way of saying there are no codes — not a code.
 */
export function lotCodesFrom(codeInfo: string, moreCodeInfo: string): string[] {
  return [codeInfo, moreCodeInfo]
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/^none\.?$/i.test(s));
}

/**
 * openFDA row -> Recall, on the `verified` tier: every field below comes from a
 * government column. No model involvement anywhere in this function, and there
 * must never be any. docs/design.md §2.
 */
export function normalizeOpenFda(row: OpenFdaRowT): Recall {
  const { states, nationwide } = parseDistribution(row.distribution_pattern);

  return RecallSchema.parse({
    id: makeId('openfda', row.recall_number),

    // Verbatim. product_description is often a full sentence with pack sizes;
    // trimming it to a short display name is a presentation decision for step 9,
    // not a data decision — shortening here would discard government text.
    product: row.product_description,
    // openFDA has no brand column. It is left empty rather than guessed at from
    // the product description, which would be a model-style inference done in
    // code. RSS records carry a real Brand Name row.
    brand: '',
    company: row.recalling_firm,
    reason: row.reason_for_recall,
    announcedDate: isoFromCompact(row.report_date),
    classification: row.classification,

    retailers: [],
    states,
    distributionRaw: row.distribution_pattern,
    nationwide,
    countryOfOrigin: null,
    lotCodes: lotCodesFrom(row.code_info, row.more_code_info),

    source: 'openfda',
    sourceUrl: openFdaSourceUrl(row.recall_number),
    confidence: 'verified',

    headline: null,
    avoidLine: null,
  });
}

/**
 * RSS item + parsed press-release <dl> -> Recall, on the `extracted` tier.
 *
 * Every factual field below comes from the parsed <dl>, not from a model. The
 * tier is called `extracted` because the PROSE fields — retailers, states,
 * country of origin, lot codes — are left empty here for step 7 to extract from
 * the page text. Brand, company, product, reason and dates are structured data
 * and stay that way. docs/design.md §2.
 */
export function normalizeFdaRss(link: string, facts: PressReleaseFactsT): Recall {
  return RecallSchema.parse({
    id: makeId('fdaRss', slugFromUrl(link)),

    product: facts.productDescription,
    brand: facts.brandName,
    company: facts.companyName,
    reason: facts.reason,
    announcedDate: facts.companyAnnouncementDate,

    // FDA has not classified this yet — press releases carry no class, and the
    // assignment arrives weeks later through openFDA. Null is the honest value.
    classification: null,

    retailers: [],
    states: [],
    distributionRaw: null,
    nationwide: false,
    countryOfOrigin: null,
    lotCodes: [],

    source: 'fdaRss',
    // Canonicalised to https: the feed emits http:// links.
    sourceUrl: link.replace(/^http:\/\//, 'https://'),
    confidence: 'extracted',

    displayName: null,
    headline: null,
    avoidLine: null,
  });
}

/** FSIS embeds HTML entities in plain-text fields ("Bea&#039;s Best"). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type FsisRecordT = z.infer<typeof FsisRecord>;

/** FSIS classes map onto the model's; anything else is passed through as-is. */
function fsisClassification(value: string): 'Class I' | 'Class II' | 'Public Health Alert' | null {
  switch (value) {
    case 'Class I':
    case 'Class II':
    case 'Public Health Alert':
      return value;
    default:
      // Class III is excluded by the inclusion rule and should never reach here.
      return null;
  }
}

/**
 * FSIS record -> Recall, on the `verified` tier. Structured government columns
 * only; no model, ever (docs/design.md §2 forbids AI anywhere near FSIS data).
 */
export function normalizeFsis(row: FsisRecordT): Recall {
  const { states, nationwide } = normalizeStateNames(row.field_states);

  // field_product_items is the itemised product list and carries the pack sizes
  // and sell-by codes. It is empty on some records — notably Public Health
  // Alerts, where the products are listed on a linked page — so the government's
  // own title is the fallback rather than inventing a description.
  const items = row.field_product_items.map(decodeEntities).filter(Boolean);
  const product = items.length > 0 ? items.join(' ') : decodeEntities(row.field_title);

  return RecallSchema.parse({
    id: makeId('fsis', row.field_recall_number),

    product,
    // FSIS has no brand column.
    brand: '',
    // field_establishment is populated on well under half of records. Empty is
    // honest; parsing the company out of the title would be inference.
    company: row.field_establishment.map(decodeEntities).filter(Boolean).join(', '),
    reason: row.field_recall_reason.map(decodeEntities).filter(Boolean).join('; '),
    announcedDate: row.field_recall_date,
    classification: fsisClassification(row.field_recall_classification),

    retailers: [],
    states,
    distributionRaw: row.field_states.join(', ') || null,
    nationwide,
    countryOfOrigin: null,
    // FSIS publishes labels as a PDF filename, not as lot codes. The codes live
    // in the product items prose, which is kept verbatim in `product`.
    lotCodes: [],

    source: 'fsis',
    sourceUrl: row.field_recall_url.replace(/^http:\/\//, 'https://'),
    confidence: 'verified',

    displayName: null,
    headline: null,
    avoidLine: null,
  });
}
