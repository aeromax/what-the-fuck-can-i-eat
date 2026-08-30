import { describe, expect, it } from 'vitest';
import { formatEastern } from '../src/dates.ts';
import { severityOf } from '../src/severity.ts';

describe('severity labels', () => {
  it('replaces Class I with plain English', () => {
    const s = severityOf({ classification: 'Class I', source: 'openfda' });
    expect(s.label).toBe('Can cause serious illness or death');
    expect(s.tone).toBe('severe');
  });

  it('quotes the issuing agency verbatim, not a paraphrase', () => {
    // The shortened badge must stay checkable against the source wording.
    const fda = severityOf({ classification: 'Class I', source: 'openfda' });
    expect(fda.agency).toBe('FDA');
    expect(fda.definition).toContain('reasonable probability');
    expect(fda.definition).toContain('serious adverse health consequences or death');
  });

  it('uses FSIS wording for FSIS records, not FDA wording', () => {
    // The two agencies classify separately and word their definitions
    // differently; attributing one's text to the other would be a misquote.
    const fsis = severityOf({ classification: 'Class I', source: 'fsis' });
    expect(fsis.agency).toBe('USDA FSIS');
    expect(fsis.definition).toContain('health hazard situation');
    expect(fsis.definition).not.toBe(
      severityOf({ classification: 'Class I', source: 'openfda' }).definition,
    );
  });

  it('never presents a Public Health Alert as a recall', () => {
    const s = severityOf({ classification: 'Public Health Alert', source: 'fsis' });
    // It must say the opposite: nothing has been recalled, so nothing is being
    // pulled from shelves. "not recalled" is the point, so match on the whole
    // phrase rather than banning the word.
    expect(s.label.toLowerCase()).toContain('not recalled');
    expect(s.label).not.toMatch(/\bis a recall\b|\brecall of\b|^recalled/i);
    expect(s.tone).toBe('alert');
  });

  it('says a null classification is unassigned rather than saying nothing', () => {
    const s = severityOf({ classification: null, source: 'fdaRss' });
    expect(s.label).toContain('not yet assigned');
    expect(s.tone).toBe('unknown');
  });
});

describe('Eastern dates', () => {
  it('labels summer dates EDT and winter dates EST', () => {
    expect(formatEastern('2026-08-24')).toEqual({ text: 'Aug 24, 2026', zone: 'EDT' });
    expect(formatEastern('2026-01-12')).toEqual({ text: 'Jan 12, 2026', zone: 'EST' });
  });

  it('never shifts the calendar date', () => {
    // A fixed UTC-5 offset would render some evening announcements a day early,
    // which both misdates the record and can move it across the 30-day window.
    for (const d of ['2026-01-01', '2026-03-08', '2026-07-04', '2026-11-01', '2026-12-31']) {
      const [, m, day] = d.split('-');
      expect(formatEastern(d).text).toContain(String(Number(day)));
      expect(formatEastern(d).text).toMatch(
        new RegExp(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]!),
      );
    }
  });

  it('falls back rather than throwing on a bad date', () => {
    expect(formatEastern('not-a-date').zone).toBe('ET');
  });
});
