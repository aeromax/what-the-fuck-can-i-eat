import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecallSchema } from '../src/recall.ts';
import { buildQuery, compactDate, fetchOpenFda, isNoMatches, selectRows } from '../scripts/sources/openfda.ts';
import { isoFromCompact, lotCodesFrom, normalizeOpenFda, openFdaSourceUrl } from '../scripts/normalize.ts';
import { OpenFdaResponse } from '../scripts/sourceSchemas.ts';
import { parseDistribution } from '../scripts/states.ts';

// The snapshot write is stubbed so these tests never touch data/. readFileSync
// is kept real — the fixture above is loaded through it.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
}));

const rows = OpenFdaResponse.parse(
  JSON.parse(readFileSync(new URL('./fixtures/openfda-enforcement.json', import.meta.url), 'utf8')),
).results;

describe('openFDA query', () => {
  it('URL-encodes the date-range brackets', () => {
    const q = buildQuery(new Date('2026-08-29T00:00:00Z'));
    expect(q).toContain('%5B');
    expect(q).toContain('%5D');
    expect(q).not.toContain('[');
  });

  it('spans 30 days back from now', () => {
    const q = buildQuery(new Date('2026-08-29T00:00:00Z'));
    expect(q).toContain('20260730');
    expect(q).toContain('20260829');
  });

  it('formats dates as YYYYMMDD', () => {
    expect(compactDate(new Date('2026-08-29T00:00:00Z'))).toBe('20260829');
  });
});

describe('inclusion rule', () => {
  const selected = selectRows(rows);

  it('keeps only Ongoing Class I, Class II and ungraded rows', () => {
    expect(selected.length).toBeGreaterThan(0);
    for (const r of selected) {
      expect(r.status).toBe('Ongoing');
      expect(['Class I', 'Class II', 'Not Yet Classified']).toContain(r.classification);
    }
  });

  it('includes ungraded rows, matching the RSS path', () => {
    // FDA grades a recall after the fact. An ungraded Ongoing recall is still an
    // active recall, and excluding it here while including unclassified RSS
    // records would be an inconsistency rather than a policy. docs/design.md §7.
    expect(selected.some((r) => r.classification === 'Not Yet Classified')).toBe(true);
  });

  it('survives a row with no recall_number', () => {
    // The ungraded Taylor Farms row has an empty recall_number, which threw
    // "makeId: empty native key" before the fallback existed. event_id alone is
    // not safe — it is shared by 21 of 43 rows — so the key pairs it with a
    // digest of the product text.
    const ungraded = selected.find((r) => r.recall_number.trim() === '');
    expect(ungraded).toBeDefined();
    const recall = normalizeOpenFda(ungraded!);
    expect(recall.id).toMatch(/^openfda:event-\d+-[0-9a-f]{8}$/);
    expect(recall.classification).toBeNull();
    expect(recall.sourceUrl).toContain('event_id');
  });

  it('gives two products in one event distinct ids', () => {
    const a = { ...selected[0]!, recall_number: '', event_id: '1234', product_description: 'Lettuce' };
    const b = { ...selected[0]!, recall_number: '', event_id: '1234', product_description: 'Spinach' };
    expect(normalizeOpenFda(a).id).not.toBe(normalizeOpenFda(b).id);
  });

  it('drops Class III, Completed and Terminated rows the fixture contains', () => {
    // The captured window really does contain all three, so this is not
    // hypothetical: 2 Class III, 1 Completed, 1 Terminated, 1 Not Yet Classified.
    expect(selected.length).toBeLessThan(rows.length);
    expect(selected.some((r) => r.classification === 'Class III')).toBe(false);
    expect(selected.some((r) => r.status !== 'Ongoing')).toBe(false);
  });
});

describe('normalizing to the verified tier', () => {
  const recalls = selectRows(rows).map(normalizeOpenFda);

  it('produces schema-valid records for every included row', () => {
    for (const r of recalls) expect(RecallSchema.safeParse(r).success).toBe(true);
  });

  it('marks every record verified with no voice', () => {
    for (const r of recalls) {
      expect(r.confidence).toBe('verified');
      expect(r.headline).toBeNull();
      expect(r.avoidLine).toBeNull();
    }
  });

  it('cites a resolvable government URL on every record', () => {
    for (const r of recalls) {
      expect(() => new URL(r.sourceUrl)).not.toThrow();
      expect(r.sourceUrl).toContain('api.fda.gov');
    }
  });

  it('round-trips the recall number into the citation', () => {
    expect(openFdaSourceUrl('H-1219-2026')).toContain('H-1219-2026');
  });

  it('converts YYYYMMDD to ISO', () => {
    expect(isoFromCompact('20260812')).toBe('2026-08-12');
    expect(() => isoFromCompact('2026-08-12')).toThrow();
  });

  it('leaves brand empty rather than inferring it', () => {
    // openFDA has no brand column. Deriving one from product_description would
    // be an inference dressed up as a fact. docs/design.md §2.
    for (const r of recalls) expect(r.brand).toBe('');
  });

  it('keeps reason and product verbatim', () => {
    const row = selectRows(rows)[0]!;
    const r = normalizeOpenFda(row);
    expect(r.reason).toBe(row.reason_for_recall);
    expect(r.product).toBe(row.product_description);
  });
});

describe('lot codes', () => {
  it('keeps free-text code_info whole rather than splitting it into invented codes', () => {
    const prose =
      'Code information is printed on the left or right sides of the carton. Codes P-1950 or 0840962';
    expect(lotCodesFrom(prose, '')).toEqual([prose]);
  });

  it('treats "None" as no codes', () => {
    expect(lotCodesFrom('None', '')).toEqual([]);
    expect(lotCodesFrom('none.', '')).toEqual([]);
  });

  it('drops absent more_code_info without emitting an empty entry', () => {
    expect(lotCodesFrom('AA051526', '')).toEqual(['AA051526']);
  });
});

describe('distribution parsing', () => {
  it('reads bare two-letter code lists', () => {
    expect(parseDistribution('MD, VA, NY').states).toEqual(['Maryland', 'New York', 'Virginia']);
  });

  it('reads full state names', () => {
    expect(parseDistribution('Arkansas, Louisiana, Mississippi').states).toEqual([
      'Arkansas',
      'Louisiana',
      'Mississippi',
    ]);
  });

  it('reads prose with a preamble and & separators', () => {
    const s = parseDistribution(
      'Product was shipped to the following states: AL, GA, KY, NC, SC, TN, VA & WV.',
    ).states;
    expect(s).toContain('Alabama');
    expect(s).toContain('West Virginia');
    expect(s.length).toBe(8);
  });

  it('flags nationwide instead of reporting no states', () => {
    // An empty state list on a nationwide recall reads as "not near me", which
    // is the most dangerous misreading available. docs/design.md §4.
    for (const t of [
      'Product is distributed through TikTok exclusively. Presumably nationwide.',
      'The product was distributed nationwide through third-party e-commerce marketplace: Amazon.com',
    ]) {
      expect(parseDistribution(t).nationwide).toBe(true);
    }
    expect(parseDistribution('MD, VA').nationwide).toBe(false);
  });

  it('does not mistake lowercase English words for state codes', () => {
    // The codes that double as words ("in", "or", "me") only collide in lower
    // case, which the case-sensitive match never sees.
    expect(parseDistribution('Distributed to Nevada for further distribution.').states).toEqual([
      'Nevada',
    ]);
    expect(parseDistribution('Only in NY.').states).toEqual(['New York']);
  });

  it('reads an uppercase ambiguous code as the state it is', () => {
    // Regression: an earlier guard required ambiguous codes to sit in a comma
    // list, which dropped Oregon from this real record and would have hidden the
    // recall from every reader in that state.
    expect(parseDistribution('only in OR.').states).toEqual(['Oregon']);
    expect(parseDistribution('IA, IL, OK, SD, TX').states).toContain('Oklahoma');
  });

  it('preserves the government text verbatim on every record', () => {
    // The parse is best-effort; the raw text is the fallback a reader can check.
    const recalls = selectRows(rows).map(normalizeOpenFda);
    for (const r of recalls) expect(typeof r.distributionRaw).toBe('string');
  });

  it('never silently reports zero states without a nationwide flag or raw text', () => {
    const recalls = selectRows(rows).map(normalizeOpenFda);
    for (const r of recalls) {
      if (r.states.length === 0) {
        expect(r.nationwide || (r.distributionRaw ?? '').length > 0).toBe(true);
      }
    }
  });
});


describe('openFDA zero-match handling', () => {
  const NOT_FOUND_BODY = '{"error":{"code":"NOT_FOUND","message":"No matches found!"}}';

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(writeFileSync).mockClear();
  });

  function stubFetch(status: number, body: string, ok = status >= 200 && status < 300) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, status, text: async () => body })),
    );
  }

  it('recognises the live NOT_FOUND body and nothing else', () => {
    // Verified live 2026-08-31: a zero-match query 404s with this body.
    expect(isNoMatches(404, NOT_FOUND_BODY)).toBe(true);
    // A wrong-but-plausible URL also 404s. Status alone is not enough.
    expect(isNoMatches(404, '<html><body>Page not found</body></html>')).toBe(false);
    expect(isNoMatches(404, '{"error":{"code":"BAD_REQUEST"}}')).toBe(false);
    expect(isNoMatches(404, '{"error":"NOT_FOUND"}')).toBe(false);
    expect(isNoMatches(404, 'null')).toBe(false);
    // Other statuses are never "no matches", whatever the body says.
    expect(isNoMatches(500, NOT_FOUND_BODY)).toBe(false);
  });

  it('reports an empty 30-day window as reachable with zero records', async () => {
    stubFetch(404, NOT_FOUND_BODY);

    const result = await fetchOpenFda(new Date('2026-08-31T00:00:00Z'));

    // Reachable, so refresh's loud "reached but returned zero" warning fires
    // instead of the footer claiming openFDA was down. An empty window is
    // normal: report_date lags initiation by a median of 69 days.
    expect(result.reachable).toBe(true);
    expect(result.recalls).toEqual([]);
    expect(result.note).toContain('WARNING');
    expect(result.note).toContain('NOT_FOUND');
  });

  it('snapshots the zero-match response rather than leaving the last good one', async () => {
    stubFetch(404, NOT_FOUND_BODY);

    await fetchOpenFda(new Date('2026-08-31T00:00:00Z'));

    const write = vi.mocked(writeFileSync).mock.calls[0];
    expect(write).toBeDefined();
    expect(String(write![0])).toContain('data/snapshots/openfda.json');
    expect(write![1]).toBe(NOT_FOUND_BODY);
  });

  it('still reports a 404 with an unexpected body as unreachable', async () => {
    stubFetch(404, '<html><body>Page not found</body></html>');

    const result = await fetchOpenFda(new Date('2026-08-31T00:00:00Z'));

    expect(result.reachable).toBe(false);
    expect(result.note).toBe('HTTP 404');
    // And nothing is snapshotted — a wrong URL must not clobber the audit trail.
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it('still reports other non-OK statuses as unreachable', async () => {
    stubFetch(503, 'Service Unavailable');

    const result = await fetchOpenFda(new Date('2026-08-31T00:00:00Z'));

    expect(result.reachable).toBe(false);
    expect(result.note).toBe('HTTP 503');
  });

  it('reports a network failure as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.fda.gov');
      }),
    );

    const result = await fetchOpenFda(new Date('2026-08-31T00:00:00Z'));

    expect(result.reachable).toBe(false);
    expect(result.note).toContain('ENOTFOUND');
  });
});
