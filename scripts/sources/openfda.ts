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
 * openFDA answers a zero-match query with **HTTP 404** and an error body, not a
 * 200 with `results: []`. Verified live 2026-08-31:
 *
 *   {"error":{"code":"NOT_FOUND","message":"No matches found!"}}
 *
 * That is a reachable source reporting an empty window, and an empty window is
 * normal here — report_date lags recall initiation by a median of 69 days, so
 * the 30-day window is often genuinely empty. Treating it as unreachable both
 * lies in the footer and routes around refresh's loud "reachable but zero"
 * warning, which is the silent-source alarm.
 *
 * The body shape is checked, not just the status: a wrong-but-plausible URL also
 * 404s, and FDA serves a plausible error page for one. Only a parsed body whose
 * `error.code` is exactly `NOT_FOUND` counts as "no matches".
 */
export function isNoMatches(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const err = (parsed as { error?: unknown }).error;
    if (typeof err !== 'object' || err === null) return false;
    return (err as { code?: unknown }).code === 'NOT_FOUND';
  } catch {
    return false;
  }
}

/**
 * Fetches the window, writes the raw response to data/snapshots/, and returns
 * normalized records. Never throws: a failing source must degrade, not blank
 * the page (docs/design.md §6), so the caller sees reachable: false instead.
 */
export async function fetchOpenFda(now = new Date()): Promise<SourceResult> {
  let raw: string;
  let noMatches = false;
  try {
    const res = await fetch(buildQuery(now));
    raw = await res.text();
    if (!res.ok) {
      if (!isNoMatches(res.status, raw)) {
        return { recalls: [], reachable: false, note: `HTTP ${res.status}` };
      }
      noMatches = true;
    }
  } catch (e) {
    return { recalls: [], reachable: false, note: (e as Error).message };
  }

  // Snapshots overwrite in place — git history is the audit trail. §6.
  //
  // The zero-match 404 body is snapshotted verbatim like any other response.
  // Leaving the previous run's records on disk would imply the last successful
  // fetch is current, which is exactly the question a snapshot exists to answer.
  writeFileSync(new URL('../../data/snapshots/openfda.json', import.meta.url), raw);

  if (noMatches) {
    return {
      recalls: [],
      reachable: true,
      note: `WARNING: openFDA reached but reported no records in the ${WINDOW_DAYS}-day window (HTTP 404 NOT_FOUND)`,
    };
  }

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
