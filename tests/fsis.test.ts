import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeFsis } from '../scripts/normalize.ts';
import { selectRecords } from '../scripts/sources/fsis.ts';
import { FsisRecord, FsisResponse } from '../scripts/sourceSchemas.ts';
import { normalizeStateNames } from '../scripts/states.ts';
import { RecallSchema } from '../src/recall.ts';

const json = (n: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

const all = FsisResponse.parse(json('fsis-recalls.json'));
const NOW = new Date('2026-08-29T00:00:00Z');

describe('FSIS inclusion rule', () => {
  const selected = selectRecords(all, NOW);

  it('filters to English so recalls are not double-counted', () => {
    expect(all.some((r) => r.langcode === 'Spanish')).toBe(true);
    expect(selected.every((r) => r.langcode === 'English')).toBe(true);
    const numbers = selected.map((r) => r.field_recall_number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('includes Public Health Alerts alongside Class I and II', () => {
    expect(selected.some((r) => r.field_recall_classification === 'Public Health Alert')).toBe(true);
  });

  it('excludes Class III', () => {
    expect(selected.some((r) => r.field_recall_classification === 'Class III')).toBe(false);
  });

  it('does not filter on field_active_notice', () => {
    // Only one live record in 2,023 is flagged True; using it as the recency
    // filter would publish a one-item page. Most selected records are not True.
    expect(selected.filter((r) => r.field_active_notice !== 'True').length).toBeGreaterThan(0);
  });

  it('uses field_recall_date for recency', () => {
    for (const r of selected) {
      const at = new Date(`${r.field_recall_date}T12:00:00Z`).getTime();
      expect(NOW.getTime() - at).toBeLessThanOrEqual(30 * 864e5);
    }
  });
});

describe('FSIS normalization', () => {
  const recalls = selectRecords(all, NOW).map(normalizeFsis);

  it('produces schema-valid verified records', () => {
    expect(recalls.length).toBeGreaterThan(0);
    for (const r of recalls) {
      expect(RecallSchema.safeParse(r).success).toBe(true);
      expect(r.confidence).toBe('verified');
      expect(r.source).toBe('fsis');
    }
  });

  it('carries no model output', () => {
    for (const r of recalls) {
      expect(r.headline).toBeNull();
      expect(r.displayName).toBeNull();
      expect(r.avoidLine).toBeNull();
    }
  });

  it('cites every record over https', () => {
    for (const r of recalls) expect(r.sourceUrl.startsWith('https://')).toBe(true);
  });

  it('decodes HTML entities in company names', () => {
    // Raw data contains "Bea&#039;s Best Corned Beef".
    for (const r of recalls) {
      expect(r.company).not.toContain('&#');
      expect(r.company).not.toContain('&amp;');
    }
  });

  it('falls back to the government title when product items are empty', () => {
    // Public Health Alerts list their products on a linked page, so
    // field_product_items is empty and the title is the only description.
    const pha = recalls.find((r) => r.classification === 'Public Health Alert')!;
    expect(pha.product.length).toBeGreaterThan(0);
  });

  it('never leaves a nationwide record looking local', () => {
    // FSIS puts the literal string "Nationwide" in field_states. A name-matching
    // filter drops it, leaving zero states — which reads as "not near me".
    expect(normalizeStateNames(['Nationwide'])).toEqual({ states: [], nationwide: true });
    const pha = recalls.find((r) => r.classification === 'Public Health Alert')!;
    expect(pha.nationwide).toBe(true);
  });

  it('keeps full state names', () => {
    const withStates = recalls.find((r) => r.states.length > 0)!;
    expect(withStates.states.every((s) => s.length > 2)).toBe(true);
  });

  it('accepts the legacy comma-joined shape', () => {
    const legacy = FsisRecord.parse(json('fsis-legacy-string-shape.json')[0]);
    const r = normalizeFsis(legacy);
    expect(r.states).toContain('Maine');
  });
});
