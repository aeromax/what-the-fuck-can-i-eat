import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { judgePair, mergeGroup, mergeRecalls, scorePair } from '../scripts/merge.ts';
import { normalizeOpenFda } from '../scripts/normalize.ts';
import { selectRows } from '../scripts/sources/openfda.ts';
import { OpenFdaResponse } from '../scripts/sourceSchemas.ts';
import { type Recall, RecallSchema } from '../src/recall.ts';

const fixture = (n: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

const mainRows = OpenFdaResponse.parse(fixture('openfda-enforcement.json')).results;
const partnerRows = OpenFdaResponse.parse(fixture('openfda-merge-partners.json')).results;
const counterparts = fixture('merge-extracted-counterparts.json');

/** Fixture records carry a `_basedOn` provenance note that is not part of the model. */
const asRecall = (raw: Record<string, unknown>): Recall => {
  const { _basedOn: _ignored, ...rest } = raw;
  return RecallSchema.parse(rest);
};

const openFda = (match: RegExp, rows = mainRows) =>
  normalizeOpenFda(rows.find((r) => match.test(r.recalling_firm))!);

// The verified half of every pair below is real captured openFDA data run
// through the real normalizer. The extracted half is reconstructed — see the
// _provenance block in merge-extracted-counterparts.json for why no live
// cross-source duplicate exists to capture.
const bazziniVerified = openFda(/bazzini/i);
const bazziniExtracted = asRecall(counterparts.bazziniPressRelease);
const kettleVerified = openFda(/kettle/i, partnerRows);
const kettleExtracted = asRecall(counterparts.kettleCuisinePressRelease);
const lidlVerified = openFda(/lidl/i, partnerRows);
const lidlExtracted = asRecall(counterparts.lidlPressRelease);

describe('confident matches', () => {
  it('merges the same recall reported by two sources', () => {
    expect(judgePair(bazziniVerified, bazziniExtracted).verdict).toBe('merge');
  });

  it('is symmetric', () => {
    // Order of comparison must not change the verdict, or output would depend on
    // input ordering and no run would ever be byte-identical to the last.
    expect(judgePair(bazziniExtracted, bazziniVerified).verdict).toBe('merge');
  });

  it('lets the verified record win every factual field', () => {
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    expect(recalls).toHaveLength(1);
    const merged = recalls[0]!;

    expect(merged.confidence).toBe('verified');
    expect(merged.source).toBe('openfda');
    expect(merged.product).toBe(bazziniVerified.product);
    expect(merged.reason).toBe(bazziniVerified.reason);
    expect(merged.lotCodes).toEqual(bazziniVerified.lotCodes);
    expect(merged.states).toEqual(bazziniVerified.states);
    // The extracted record had no classification; the verified one does.
    expect(merged.classification).toBe('Class I');
  });

  it('carries voice across so it is never regenerated', () => {
    // docs/design.md §6. The merged record keeps the verified record's id, so
    // without this voice.ts would see an id with no headline and pay to write
    // one again — and the page's wording would change under the reader.
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    const merged = recalls[0]!;

    expect(bazziniVerified.headline).toBeNull();
    expect(merged.headline).toBe(bazziniExtracted.headline);
    expect(merged.displayName).toBe(bazziniExtracted.displayName);
    expect(merged.avoidLine).toBe(bazziniExtracted.avoidLine);
  });

  it('keeps every citation', () => {
    // §2 requires a reader to be able to check the government page a fact came
    // from. After a merge the record came from two pages; dropping one would
    // silently destroy a citation.
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    const merged = recalls[0]!;

    expect(merged.sourceUrl).toBe(bazziniVerified.sourceUrl);
    expect(merged.mergedFrom).toHaveLength(1);
    expect(merged.mergedFrom[0]!.sourceUrl).toBe(bazziniExtracted.sourceUrl);
  });

  it('produces a schema-valid record', () => {
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    expect(RecallSchema.safeParse(recalls[0]).success).toBe(true);
  });
});

describe('the dangerous case: two recalls from one company', () => {
  // This is the failure the whole ambiguity rule exists to prevent. Both pairs
  // are REAL: same firm, same 30-day-ish era, genuinely different recalls.

  it('does not merge Kettle Cuisine minestrone with tomato bisque', () => {
    // openFDA H-0941-2026 is Minestrone with undeclared shrimp; the RSS item is
    // a Tomato Bisque kit with foreign matter. Merging would put the shrimp
    // allergen warning and the minestrone lot codes on a tomato soup.
    expect(judgePair(kettleVerified, kettleExtracted).verdict).toBe('ambiguous');
  });

  it('does not merge Lidl chocolate with Lidl spice mix', () => {
    expect(judgePair(lidlVerified, lidlExtracted).verdict).toBe('ambiguous');
  });

  it('leaves both records published and flags the pair for a human', () => {
    const { recalls, review, mergedCount } = mergeRecalls([kettleVerified, kettleExtracted]);
    expect(mergedCount).toBe(0);
    expect(recalls).toHaveLength(2);
    expect(review).toHaveLength(1);
    expect(review[0]!.records).toHaveLength(2);
    // Both entries intact, per docs/design.md §6.
    expect(review[0]!.records.map((r) => r.id).sort()).toEqual(
      [kettleVerified.id, kettleExtracted.id].sort(),
    );
  });

  it('does not merge two Clover Hill cheeses that share a reason AND a lot code', () => {
    // The hardest real case in the live data, and the one that broke an earlier
    // version of this file. Clover Hill Dairy filed 18 separate recalls that all
    // carry the SAME reason ("Product contaminated with Listeria monocytogenes.")
    // and the SAME lot code (AA051526) — the code identifies the firm's
    // production run, not the product. Every corroborating signal agrees except
    // the product itself.
    //
    // Merging them would drop one of two genuinely recalled cheeses off the page.
    const cheeses = selectRows(mainRows)
      .filter((r) => /clover hill/i.test(r.recalling_firm))
      .map(normalizeOpenFda);
    expect(cheeses.length).toBeGreaterThan(5);

    const a = cheeses[0]!;
    const b: Recall = {
      ...cheeses[5]!,
      source: 'fdaRss',
      confidence: 'extracted',
      classification: null,
      id: 'fdaRss:clover-hill-press-release',
      sourceUrl: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/clover-hill',
    };

    const scores = scorePair(a, b);
    expect(scores.company).toBe(1);
    expect(scores.reason).toBe(1);
    expect(scores.sharedLotCodes).toBeGreaterThan(0);

    expect(judgePair(a, b).verdict).toBe('ambiguous');

    const { mergedCount, recalls } = mergeRecalls([a, b]);
    expect(mergedCount).toBe(0);
    expect(recalls).toHaveLength(2);
  });

  it('does not let a shared lot code alone confirm a match', () => {
    // AA051526 is printed across an entire product line, so "same lot code"
    // means "same firm", not "same product".
    const a = { ...bazziniVerified, product: 'Cheddar Cheese Sticks', lotCodes: ['AA051526'] };
    const b = { ...bazziniExtracted, product: 'Pepper Jack Cubes', lotCodes: ['AA051526'] };
    expect(scorePair(a, b).sharedLotCodes).toBe(1);
    expect(judgePair(a, b).verdict).toBe('ambiguous');
  });

  it('ignores openFDA boilerplate when comparing products', () => {
    // "Unknown information regarding packaging/labeling. Approximate total
    // quantity..." is repeated verbatim on every row a firm files, and supplied
    // 7 of 11 apparently-shared words between two unrelated cheeses.
    const boiler = 'Unknown information regarding packaging and labeling. Approximate total quantity.';
    const a = { ...bazziniVerified, product: `Colby Marble Jack. ${boiler}` };
    const b = { ...bazziniExtracted, product: `Sharp Cheddar Stix. ${boiler}` };
    expect(scorePair(a, b).product).toBeLessThan(0.5);
    expect(judgePair(a, b).verdict).toBe('ambiguous');
  });

  it('never mixes lot codes between two different products', () => {
    // The acceptance criterion for step 6.
    const all = [kettleVerified, kettleExtracted, lidlVerified, lidlExtracted];
    const { recalls } = mergeRecalls(all);
    for (const merged of recalls) {
      const origin = all.find((r) => r.id === merged.id)!;
      expect(merged.lotCodes).toEqual(origin.lotCodes);
    }
  });
});

describe('hard gates', () => {
  const base = bazziniVerified;

  it('never merges two records from the same source', () => {
    // One agency filing two rows means two recalls. Clover Hill Dairy alone
    // files 18 near-identical cheese rows in the live window.
    const twin = { ...bazziniExtracted, source: 'openfda' as const, id: 'openfda:twin' };
    expect(judgePair(base, twin).verdict).toBe('unrelated');
  });

  it('never merges across conflicting classifications', () => {
    const other = { ...bazziniExtracted, classification: 'Class II' as const };
    expect(judgePair(base, other).verdict).toBe('unrelated');
  });

  it('merges happily when one side is unclassified', () => {
    // Null means "FDA has not graded this yet", which is the normal state of a
    // fresh press release — not a disagreement.
    expect(bazziniExtracted.classification).toBeNull();
    expect(judgePair(base, bazziniExtracted).verdict).toBe('merge');
  });

  it('refuses to match when a company is missing', () => {
    // FSIS leaves field_establishment empty on most records. Without a company
    // there is no identity anchor, and guessing from product text alone is how
    // unrelated meat and produce recalls would get fused.
    const anonymous = { ...bazziniExtracted, company: '' };
    expect(judgePair(base, anonymous).verdict).toBe('unrelated');
  });

  it('refuses to match across unrelated years', () => {
    const ancient = { ...bazziniExtracted, announcedDate: '2024-01-05' };
    expect(judgePair(base, ancient).verdict).toBe('unrelated');
  });

  it('tolerates the real openFDA reporting lag', () => {
    // report_date lags initiation by a median of 69 days and up to 196 observed,
    // so a gate tight enough to feel safe would reject every genuine upgrade.
    const lagged = { ...bazziniExtracted, announcedDate: '2026-02-20' };
    expect(judgePair(base, lagged).verdict).toBe('merge');
  });
});

describe('scoring', () => {
  it('treats company suffixes as noise', () => {
    const a = { ...bazziniVerified, company: 'Kettle Cuisine, LLC' };
    const b = { ...bazziniExtracted, company: 'Kettle Cuisine' };
    expect(scorePair(a, b).company).toBe(1);
  });

  it('does not treat different companies as the same', () => {
    const a = { ...bazziniVerified, company: 'Clover Hill Dairy, LLC' };
    const b = { ...bazziniExtracted, company: 'La Colonia Foods Llc' };
    expect(scorePair(a, b).company).toBeLessThan(0.6);
  });

  it('ignores years and short strings when comparing lot codes', () => {
    const a = { ...bazziniVerified, lotCodes: ['Lot 2026 AB'] };
    const b = { ...bazziniExtracted, lotCodes: ['Best by 2026 XY'] };
    // "2026" is not an identifying code; matching on it would fuse unrelated
    // recalls that merely share a year.
    expect(scorePair(a, b).sharedLotCodes).toBe(0);
  });

  it('recognises a genuinely shared lot code', () => {
    const a = { ...bazziniVerified, lotCodes: ['B15354, B15356'] };
    const b = { ...bazziniExtracted, lotCodes: ['Lot codes: B15354'] };
    expect(scorePair(a, b).sharedLotCodes).toBe(1);
  });
});

describe('the whole pass', () => {
  it('is deterministic and idempotent', () => {
    // "A run that changes nothing must not commit" depends on this exactly.
    const input = [bazziniExtracted, bazziniVerified, kettleVerified, kettleExtracted];
    const once = mergeRecalls(input);
    const twice = mergeRecalls(once.recalls);
    expect(JSON.stringify(mergeRecalls(input).recalls)).toBe(JSON.stringify(once.recalls));
    expect(twice.recalls.map((r) => r.id)).toEqual(once.recalls.map((r) => r.id));
  });

  it('does not depend on input order', () => {
    const input = [bazziniExtracted, bazziniVerified, lidlVerified, lidlExtracted];
    const forward = mergeRecalls(input).recalls.map((r) => r.id);
    const backward = mergeRecalls([...input].reverse()).recalls.map((r) => r.id);
    expect(backward).toEqual(forward);
  });

  it('sorts newest announcement first', () => {
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified, kettleVerified]);
    const dates = recalls.map((r) => r.announcedDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('leaves the live unmerged set untouched when nothing matches', () => {
    // selectRows first, exactly as the pipeline does. One live row is
    // "Not Yet Classified" AND carries an empty recall_number, so normalizing
    // the raw feed without the inclusion rule throws in makeId.
    const live = selectRows(mainRows).map(normalizeOpenFda);
    const { recalls, mergedCount, review } = mergeRecalls(live);
    // All one source, so nothing can merge and nothing is ambiguous.
    expect(mergedCount).toBe(0);
    expect(review).toHaveLength(0);
    expect(recalls).toHaveLength(live.length);
  });
});

describe('open question 3: which date survives a merge', () => {
  it('keeps the earliest known announcement date', () => {
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    // openFDA's date is report_date — when FDA published the enforcement report,
    // not when the public was told. The press release date is the real one.
    expect(bazziniVerified.announcedDate).toBe('2026-08-19');
    expect(recalls[0]!.announcedDate).toBe('2026-05-23');
  });

  it('never drops a record because better data arrived', () => {
    // The 30-day window is applied per source BEFORE merging and is not
    // re-applied here, so taking an older date cannot remove an item.
    const { recalls } = mergeRecalls([bazziniExtracted, bazziniVerified]);
    expect(recalls).toHaveLength(1);
    expect(mergeGroup([bazziniVerified, bazziniExtracted]).announcedDate).toBe('2026-05-23');
  });
});
