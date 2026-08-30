import { z } from 'zod';

// The Recall record is the whole data model. See docs/design.md §3.
//
// Why `zod` and not `astro/zod`: the astro/zod rule in CLAUDE.md applies to
// content-collection schemas. This project has no content collections — the page
// imports data/recalls.json plainly — and scripts/ runs under bare Node, where
// reaching into Astro's subpath export would drag the framework into the data
// pipeline for no benefit. Both are Zod 4.

/** Where a record's facts came from, and therefore how far it can be trusted. */
export const Confidence = z.enum([
  // Every fact came from structured government columns. No model output in any
  // factual field.
  'verified',
  // A model read press-release prose for retailers/states/origin/lot codes.
  // Brand, company, product and reason are still structured or <dl>-parsed.
  'extracted',
]);

export const Source = z.enum(['openfda', 'fdaRss', 'fsis']);

/**
 * Class III is excluded as the boring tier — an editorial call, docs/design.md §7.
 *
 * `Public Health Alert` is FSIS-only and is not a recall class at all: FSIS
 * issues one when contaminated product is believed to be in commerce but no
 * recall has been requested. Included deliberately (decision 2026-08-29), on the
 * grounds that the page's standard is "food you should not eat right now" and a
 * PHA meets it — arguably more urgently than a Class II, since nothing has been
 * withdrawn. The page must not present it as a recall; see docs/design.md §7.
 */
export const Classification = z.enum(['Class I', 'Class II', 'Public Health Alert']);

export const RecallSchema = z.object({
  /** `${source}:${native key}` — stable across runs. See `makeId`. */
  id: z.string().min(1),

  // --- Facts. Never model-written. -----------------------------------------
  /**
   * The government's product text, verbatim. Often a full spec line with pack
   * sizes and UPCs. Never shortened here and never model-written — `displayName`
   * exists so this can stay whole.
   */
  product: z.string().min(1),
  /**
   * A short common food name for the large type: "eggs", "ground beef",
   * "lettuce". Model-written (decision 2026-08-29, docs/design.md §10.6).
   *
   * This is a NAMING field, not a factual one, and it is deliberately the only
   * model-written string allowed anywhere near the product identity. It carries
   * a specific hazard: a category name generalizes one recalled product into a
   * whole food group, so "eggs" alone could read as every egg on the shelf.
   *
   * It is therefore never rendered alone — the component pairs it with the
   * identifying detail, and `product` is always still on the record. If it is
   * null, the page falls back to `product`. Never let a layout show this field
   * as the sole identifier.
   */
  displayName: z.string().nullable().default(null),
  brand: z.string(),
  company: z.string(),
  /** Verbatim government text. Never rewritten, summarised or tidied. */
  reason: z.string().min(1),
  /** ISO YYYY-MM-DD. Sources disagree on format; normalize on the way in. */
  announcedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * Null means "not yet classified", which is the normal state of a fresh FDA
   * press release: classification arrives weeks later via openFDA, and that lag
   * is the entire reason the RSS path exists. Treating null as excluded would
   * empty the `extracted` tier. See docs/design.md §7.
   */
  classification: Classification.nullable().default(null),

  // --- Facts that are structured on the verified tier and model-extracted on
  // --- the extracted tier. docs/design.md §2.
  retailers: z.array(z.string()).default([]),
  /** Full state names, normalized. openFDA emits 2-letter codes; FSIS emits names. */
  states: z.array(z.string()).default([]),
  /**
   * Verbatim government distribution text, kept because `states` is a
   * best-effort parse of free text that comes in 21 distinct shapes. If the
   * parse under-reports, the reader can still see what the government said.
   * Never model-written.
   */
  distributionRaw: z.string().nullable().default(null),
  /**
   * Set when the source says the product went everywhere. Without this, a
   * nationwide recall parses to zero states and reads on the page as "not near
   * me" — the most dangerous possible misreading of an empty list.
   */
  nationwide: z.boolean().default(false),
  countryOfOrigin: z.string().nullable().default(null),
  lotCodes: z.array(z.string()).default([]),

  // --- Provenance ----------------------------------------------------------
  source: Source,
  /** The government page a reader can go and check. Always present. */
  sourceUrl: z.url(),
  confidence: Confidence,
  /**
   * Records folded into this one by merge.ts, with their citations.
   *
   * §2 requires every record to keep a `sourceUrl` pointing at the government
   * page it came from. After a merge the record came from more than one page,
   * and dropping the loser's URL would quietly destroy a citation a reader could
   * otherwise check. Verbatim ids and URLs only — nothing inferred.
   */
  mergedFrom: z
    .array(z.object({ id: z.string(), source: Source, sourceUrl: z.url() }))
    .default([]),

  // --- Voice. Model-written, written once, then frozen. --------------------
  /** Snark lives here and nowhere else. Absent until scripts/voice.ts runs. */
  headline: z.string().nullable().default(null),
  /** Deadpan. The line someone reads while holding the product. */
  avoidLine: z.string().nullable().default(null),
});

export type Recall = z.infer<typeof RecallSchema>;
export type Source = z.infer<typeof Source>;
export type Confidence = z.infer<typeof Confidence>;

/**
 * Resolves docs/design.md §10 open question 1.
 *
 * Ids are namespaced per source rather than shared across sources, because the
 * three sources have no common key: openFDA has `recall_number` (H-1219-2026),
 * FSIS has its own `field_recall_number` (018-2026) — which collide in shape but
 * mean different things — and an RSS item has nothing but a URL.
 *
 * So the id is deliberately NOT the cross-source merge key. It only has to be
 * stable for one source across runs, which is what lets voice.ts skip records
 * that already have a headline. Matching the same recall across sources is
 * merge.ts's job, done on content, with ambiguity routed to review.json rather
 * than guessed at (docs/design.md §6).
 */
export function makeId(source: Source, nativeKey: string): string {
  const key = nativeKey.trim().toLowerCase().replace(/\s+/g, '-');
  if (!key) throw new Error(`makeId: empty native key for source ${source}`);
  return `${source}:${key}`;
}

/** An RSS item's only stable handle is its press-release URL slug. */
export function slugFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop();
  if (!last) throw new Error(`slugFromUrl: no slug in ${url}`);
  return last;
}
