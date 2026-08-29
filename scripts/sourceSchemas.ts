import { z } from 'zod';

// Shapes of the raw government responses, validated before normalize.ts touches
// them. Every field here is transcribed from a live response captured on
// 2026-08-29 into tests/fixtures/.
//
// These schemas are deliberately permissive about fields we do not use and
// strict about the ones we do: an upstream shape change should fail loudly at
// the source boundary, not silently produce a page with missing lot codes.

// --- openFDA -----------------------------------------------------------------

export const OpenFdaRow = z.object({
  status: z.string(),
  classification: z.string(),
  product_type: z.string(),
  recall_number: z.string(),
  recalling_firm: z.string(),
  product_description: z.string(),
  reason_for_recall: z.string(),
  /** YYYYMMDD strings, not numbers and not ISO. docs/design.md §4. */
  report_date: z.string().regex(/^\d{8}$/),
  recall_initiation_date: z.string().regex(/^\d{8}$/).optional(),
  center_classification_date: z.string().optional(),
  /** Free text. Sometimes 2-letter codes, sometimes full names, sometimes prose. */
  distribution_pattern: z.string(),
  /**
   * Lot codes, structured — this is why openFDA records need no extraction.
   * Present on all 43 records in the captured window; treated as required so a
   * future absence fails loudly rather than quietly dropping lot codes.
   */
  code_info: z.string(),
  /** Absent (not empty) on 3 of 43 captured records. */
  more_code_info: z.string().default(''),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  event_id: z.string(),
});

export const OpenFdaResponse = z.object({
  meta: z.object({
    results: z.object({ skip: z.number(), limit: z.number(), total: z.number() }),
  }),
  results: z.array(OpenFdaRow),
});

// --- FDA RSS -----------------------------------------------------------------

export const FdaRssItem = z.object({
  title: z.string(),
  link: z.url(),
  description: z.string(),
  /** RFC-822 with the ALPHABETIC zone `EDT`. Must be parsed deliberately. */
  pubDate: z.string(),
  guid: z.union([z.string(), z.object({ '#text': z.string() }).loose()]),
});

export const FdaRssFeed = z.object({
  rss: z.object({
    channel: z.object({
      title: z.string(),
      // fast-xml-parser must be configured with
      // `isArray: (n) => n === 'item'`, or a single-item feed silently
      // deserialises to an object and this schema is what catches it.
      item: z.array(FdaRssItem),
    }),
  }),
});

// --- FSIS --------------------------------------------------------------------

/**
 * A June 2026 API change flipped ten fields from comma-joined strings to arrays.
 * As of 2026-08-29 every one of the 2,023 live records uses the array shape and
 * none use the string shape, so the string branch is now unexercised by live
 * data — it is kept because the cost is one line and the failure it prevents
 * (meat recalls silently vanishing) is the worst non-textual failure in the
 * system. tests/fixtures/fsis-legacy-string-shape.json exercises it synthetically.
 */
const stringOrArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    Array.isArray(v)
      ? v
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
  );

export const FsisRecord = z.object({
  field_title: z.string(),
  field_recall_number: z.string(),
  field_recall_url: z.string(),
  /** "Class I" | "Class II" | "Class III" | "Public Health Alert". */
  field_recall_classification: z.string(),
  /** ISO YYYY-MM-DD, unlike openFDA's YYYYMMDD. */
  field_recall_date: z.string(),
  /** Every recall appears once per langcode. Filter to English or double-count. */
  langcode: z.string(),
  field_active_notice: z.string(),
  field_summary: z.string(),
  field_recall_reason: stringOrArray,
  /** Full state names, unlike openFDA's 2-letter codes. */
  field_states: stringOrArray,
  field_product_items: stringOrArray,
  field_establishment: stringOrArray,
  field_labels: stringOrArray,
  field_distro_list: stringOrArray,
  field_processing: stringOrArray,
  field_recall_type: z.string(),
  field_year: z.string(),
});

export const FsisResponse = z.array(FsisRecord);

// --- FDA press-release <dl> ---------------------------------------------------

/**
 * The parsed <dl> block. No model involvement — these are the fields the model is
 * never allowed to supply. docs/design.md §2.
 */
export const PressReleaseFacts = z.object({
  companyName: z.string(),
  brandName: z.string(),
  productDescription: z.string(),
  reason: z.string(),
  companyAnnouncementDate: z.string(),
  /**
   * "Food & Beverages" for human food; "Animal & Veterinary ..." for pet food.
   * This is the structured pet-food discriminator — see tests. Note that pet
   * items ALSO contain "Food & Beverages", so the rule is exclude-on-Animal,
   * never include-on-Food.
   */
  productType: z.string(),
});
