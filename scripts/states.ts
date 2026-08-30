// US state normalisation. openFDA emits 2-letter codes inside free-text prose;
// FSIS emits full names in an array. Comparing them without normalising silently
// under-matches, which is a merge hazard — docs/design.md §4.

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands', GU: 'Guam', AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

const BY_NAME = new Map(Object.values(STATES).map((name) => [name.toLowerCase(), name]));

/** Phrases that mean "everywhere", which must never be reported as no states. */
const NATIONWIDE = /\b(nationwide|nation-wide|all 50 states|throughout the united states)\b/i;

export interface Distribution {
  /** Full state names, deduped and sorted. Best-effort. */
  states: string[];
  /** True when the government text says nationwide, however phrased. */
  nationwide: boolean;
}

/**
 * Best-effort parse of openFDA's free-text distribution_pattern.
 *
 * Deliberately conservative: it under-reports rather than guesses. The verbatim
 * government text is preserved on the record as `distributionRaw`, so a failure
 * here loses convenience, never facts. See docs/design.md §4.
 */
export function parseDistribution(text: string): Distribution {
  const nationwide = NATIONWIDE.test(text);
  const found = new Set<string>();

  // Full names first, so "Washington" is not later re-matched as a stray code.
  for (const [lower, name] of BY_NAME) {
    if (new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      found.add(name);
    }
  }

  // Then 2-letter codes. The match is deliberately case-SENSITIVE: the codes
  // that double as English words ("IN", "OR", "ME", "OK") only collide in their
  // lowercase forms, which this never matches.
  //
  // An earlier version additionally refused those ambiguous codes unless they
  // sat in a comma-separated list. Checked against all 21 distinct
  // distribution_pattern shapes in the captured window (2026-08-29), every
  // uppercase occurrence was a real state, and the guard silently dropped
  // Oregon from "only in OR." — so it was removed.
  //
  // Residual risk is an all-caps product blob yielding a spurious state. That is
  // accepted on purpose: over-reporting a state is a false alarm, under-reporting
  // hides a risk from someone standing in that state. When uncertain, be
  // redundant rather than confident — docs/design.md §6.
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    const name = STATES[m[1]!];
    if (name) found.add(name);
  }

  return { states: [...found].sort(), nationwide };
}

/**
 * FSIS emits full names in an array — but not only names. A nationwide recall
 * carries the literal value "Nationwide" in `field_states`, which is not a
 * state and which a name-matching filter drops on the floor. Dropping it turns
 * a nationwide public health alert into a record affecting nowhere, and an
 * empty state list reads as "not near me".
 */
export function normalizeStateNames(names: string[]): Distribution {
  const out = new Set<string>();
  let nationwide = false;

  for (const raw of names) {
    const n = raw.trim();
    if (NATIONWIDE.test(n)) {
      nationwide = true;
      continue;
    }
    const hit = BY_NAME.get(n.toLowerCase()) ?? STATES[n.toUpperCase()];
    if (hit) out.add(hit);
  }

  return { states: [...out].sort(), nationwide };
}
