import type { Recall } from './recall.ts';

/**
 * Plain-English severity for the page, replacing "Class I" / "Class II" — which
 * mean nothing to someone holding a jar.
 *
 * These labels are a FIXED LEGEND, not per-record inference. They are written
 * once, reviewed once, and applied by a lookup on a government-supplied class.
 * No model sees them and nothing about an individual recall is deduced here, so
 * this does not widen the AI/facts boundary in docs/design.md §2. The verbatim
 * agency definition travels with each label so the shortening is checkable.
 *
 * FDA and FSIS classify separately and word their definitions differently, so
 * the correct definition depends on which agency issued the record.
 *
 * Sources, fetched 2026-08-29:
 * - FDA: https://www.fda.gov/safety/industry-guidance-recalls/recalls-background-and-definitions
 * - FSIS: the "USDA Recall Classifications" block printed on every recall page,
 *   e.g. https://www.fsis.usda.gov/recalls-alerts/
 */
export interface Severity {
  /** Short plain-English label for the badge. */
  label: string;
  /** The issuing agency's own definition, verbatim. Never paraphrased. */
  definition: string;
  agency: 'FDA' | 'USDA FSIS' | null;
  /** Drives styling: how loud the badge should be. */
  tone: 'severe' | 'moderate' | 'alert' | 'unknown';
}

const FDA_CLASS_I =
  'a situation in which there is a reasonable probability that the use of or exposure to a violative product will cause serious adverse health consequences or death.';
const FDA_CLASS_II =
  'a situation in which use of or exposure to a violative product may cause temporary or medically reversible adverse health consequences or where the probability of serious adverse health consequences is remote.';

const FSIS_CLASS_I =
  'This is a health hazard situation where there is a reasonable probability that the use of the product will cause serious, adverse health consequences or death.';
const FSIS_CLASS_II =
  'This is a health hazard situation where there is a remote probability of adverse health consequences from the use of the product.';

export function severityOf(recall: Pick<Recall, 'classification' | 'source'>): Severity {
  const fsis = recall.source === 'fsis';

  switch (recall.classification) {
    case 'Class I':
      return {
        label: 'Can cause serious illness or death',
        definition: fsis ? FSIS_CLASS_I : FDA_CLASS_I,
        agency: fsis ? 'USDA FSIS' : 'FDA',
        tone: 'severe',
      };
    case 'Class II':
      return {
        label: fsis
          ? 'Remote chance of illness'
          : 'Can cause temporary or reversible illness',
        definition: fsis ? FSIS_CLASS_II : FDA_CLASS_II,
        agency: fsis ? 'USDA FSIS' : 'FDA',
        tone: 'moderate',
      };
    case 'Public Health Alert':
      return {
        // A PHA is NOT a recall and must never be labelled as one. FSIS issues
        // one when contaminated product is believed to be in commerce and no
        // recall has been requested — so nothing is being taken off shelves.
        label: 'Warning — not recalled, may still be on sale',
        definition:
          'FSIS issues a public health alert when there is reason to believe affected product is in commerce but a recall has not been requested.',
        agency: 'USDA FSIS',
        tone: 'alert',
      };
    default:
      return {
        // Null is the normal state of a fresh FDA press release: the class is
        // assigned weeks later. Saying so is more honest than saying nothing.
        label: 'Severity not yet assigned by FDA',
        definition:
          'FDA assigns a recall classification after evaluating the health hazard. Recently announced recalls are often not yet classified.',
        agency: null,
        tone: 'unknown',
      };
  }
}
