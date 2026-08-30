import { writeFileSync } from 'node:fs';
import { Impit } from 'impit';
import type { z } from 'zod';
import type { Recall } from '../../src/recall.ts';
import { normalizeFsis } from '../normalize.ts';
import { FsisResponse, type FsisRecord } from '../sourceSchemas.ts';

type FsisRecordT = z.infer<typeof FsisRecord>;

export const FSIS_API = 'https://www.fsis.usda.gov/fsis/api/recall/v/1';
const WINDOW_DAYS = 30;

/** Class III is the excluded boring tier; PHAs are included on purpose (§7). */
const INCLUDED = new Set(['Class I', 'Class II', 'Public Health Alert']);

/**
 * Applies the inclusion rule. Testable without the network.
 *
 * Two traps live here, both of which fail silently rather than loudly:
 *
 * - `langcode` — every recall appears twice, once per language. Without this
 *   filter the page double-counts every meat recall.
 * - `field_active_notice` is NOT the recency filter. Exactly one of 2,023 live
 *   records is "True", so filtering on it would publish a one-item page.
 *   Recency comes from `field_recall_date`.
 */
export function selectRecords(rows: FsisRecordT[], now = new Date()): FsisRecordT[] {
  const cutoff = now.getTime() - WINDOW_DAYS * 864e5;

  return rows.filter((r) => {
    if (r.langcode !== 'English') return false;
    if (!INCLUDED.has(r.field_recall_classification)) return false;

    const at = new Date(`${r.field_recall_date}T12:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.getTime() >= cutoff;
  });
}

export interface FsisResult {
  recalls: Recall[];
  reachable: boolean;
  note: string;
}

/**
 * Fetches via impit, not fetch.
 *
 * The block is TLS fingerprinting, and it is real: on 2026-08-29 plain fetch()
 * got HTTP 403 on www.fsis.usda.gov HTML pages while this API endpoint returned
 * 200 — so the block is path-dependent and can evidently be switched on. impit
 * got through both. Do not "simplify" this to fetch() because the API happens to
 * answer today, and do not try to fix a future block with headers.
 */
export async function fetchFsis(now = new Date()): Promise<FsisResult> {
  let raw: string;
  try {
    const res = await new Impit({ browser: 'chrome' }).fetch(FSIS_API);
    if (!res.ok) return { recalls: [], reachable: false, note: `HTTP ${res.status}` };
    if (!/json/i.test(res.headers.get('content-type') ?? '')) {
      return { recalls: [], reachable: false, note: 'non-JSON response (blocked?)' };
    }
    raw = await res.text();
  } catch (e) {
    return { recalls: [], reachable: false, note: (e as Error).message };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { recalls: [], reachable: false, note: 'response was not valid JSON' };
  }

  const parsed = FsisResponse.safeParse(parsedJson);
  if (!parsed.success) {
    return { recalls: [], reachable: false, note: `schema rejected: ${parsed.error.message}` };
  }

  const rows = selectRecords(parsed.data, now);

  // Snapshot the SELECTED records, not the whole response.
  //
  // This deviates from "raw API responses" in docs/design.md §5, deliberately.
  // The full feed is 12.9 MB of 2,023 records, 99% of them years old and
  // irrelevant. Committing it on every change would add gigabytes to git history
  // per year, which the design explicitly set out to avoid when it ruled out
  // accumulating timestamped snapshots. The audit question this file has to
  // answer is "did the government say this, or did the model invent it?" — and
  // the selected records answer that completely for everything published.
  writeFileSync(
    new URL('../../data/snapshots/fsis.json', import.meta.url),
    `${JSON.stringify(rows, null, 1)}\n`,
  );

  const recalls = rows.map(normalizeFsis);

  // A silent FSIS failure means meat, poultry and egg recalls vanish while the
  // page still looks complete. Any zero must be loud. docs/design.md §4.
  const note =
    recalls.length === 0
      ? `WARNING: FSIS returned ${parsed.data.length} records but none passed the inclusion rule — meat and poultry recalls will be missing`
      : `${recalls.length} of ${parsed.data.length} records included`;

  return { recalls, reachable: true, note };
}
