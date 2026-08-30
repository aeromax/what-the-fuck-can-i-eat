import { writeFileSync } from 'node:fs';
import type { z } from 'zod';
import type { Recall } from '../../src/recall.ts';
import { normalizeOpenFda } from '../normalize.ts';
import { OpenFdaResponse, type OpenFdaRow } from '../sourceSchemas.ts';

type OpenFdaRowT = z.infer<typeof OpenFdaRow>;

const ENDPOINT = 'https://api.fda.gov/food/enforcement.json';
const WINDOW_DAYS = 30;

/**
 * Classifications the inclusion rule admits from openFDA. docs/design.md §7.
 *
 * "Not Yet Classified" is included for the same reason unclassified RSS records
 * are: FDA grades a recall after the fact, and an ungraded Ongoing recall is
 * still an active recall. Excluding it here while including it on the RSS path
 * would have been an inconsistency, not a policy.
 */
const INCLUDED = new Set(['Class I', 'Class II', 'Not Yet Classified']);

export function compactDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Date-range brackets must be URL-encoded or the API errors. The window is on
 * report_date — which lags the announcement by weeks. That lag is exactly why
 * the RSS path exists, and which date should govern the 30-day window across
 * sources is docs/design.md §10 open question 3, still open.
 */
export function buildQuery(now: Date, limit = 100): string {
  const from = new Date(now.getTime() - WINDOW_DAYS * 864e5);
  const range = `report_date:[${compactDate(from)}+TO+${compactDate(now)}]`;
  return `${ENDPOINT}?search=${encodeURIComponent(range).replace(/%2B/g, '+')}&limit=${limit}`;
}

/**
 * Applies the inclusion rule. Kept separate from the fetch so it is testable
 * against the captured fixture without touching the network.
 */
export function selectRows(rows: OpenFdaRowT[]): OpenFdaRowT[] {
  return rows.filter((r) => r.status === 'Ongoing' && INCLUDED.has(r.classification));
}

export interface SourceResult {
  recalls: Recall[];
  /** Reported in the page footer so a silent source failure is visible. §6. */
  reachable: boolean;
  note: string;
}

/**
 * Fetches the window, writes the raw response to data/snapshots/, and returns
 * normalized records. Never throws: a failing source must degrade, not blank
 * the page (docs/design.md §6), so the caller sees reachable: false instead.
 */
export async function fetchOpenFda(now = new Date()): Promise<SourceResult> {
  let raw: string;
  try {
    const res = await fetch(buildQuery(now));
    if (!res.ok) return { recalls: [], reachable: false, note: `HTTP ${res.status}` };
    raw = await res.text();
  } catch (e) {
    return { recalls: [], reachable: false, note: (e as Error).message };
  }

  // Snapshots overwrite in place — git history is the audit trail. §6.
  writeFileSync(new URL('../../data/snapshots/openfda.json', import.meta.url), raw);

  const parsed = OpenFdaResponse.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return { recalls: [], reachable: false, note: `schema rejected: ${parsed.error.message}` };
  }

  const rows = selectRows(parsed.data.results);
  const recalls = rows.map(normalizeOpenFda);

  // A source contributing zero items must warn loudly rather than shrug — a
  // silent empty source looks identical to a quiet week. §4.
  const note =
    recalls.length === 0
      ? `WARNING: openFDA returned ${parsed.data.results.length} rows but none passed the inclusion rule`
      : `${recalls.length} of ${parsed.data.results.length} rows included`;

  return { recalls, reachable: true, note };
}
