import type { z } from 'zod';
import { type Recall, RecallSchema, makeId } from '../src/recall.ts';
import type { OpenFdaRow } from './sourceSchemas.ts';
import { parseDistribution } from './states.ts';

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
