import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
import RecallRow from '../src/components/Recall.astro';
import { RecallSchema } from '../src/recall.ts';

const base = RecallSchema.parse({
  id: 'openfda:h-9999-2026',
  product:
    'Grade A Brown In-shell Chicken eggs packaged in the following configurations: 1. Simple Truth, Natural Cage Free Grain Fed, Medium, 12 Eggs, Net Wt 21 oz (1lb 5oz) 596g, UPC 0 11110-87032 0.',
  brand: '',
  company: 'Example Farms LLC',
  reason: 'Products may be contaminated with Salmonella.',
  announcedDate: '2026-08-19',
  classification: 'Class I',
  states: ['Ohio'],
  distributionRaw: 'OH',
  lotCodes: ['P-1234'],
  source: 'openfda',
  sourceUrl: 'https://api.fda.gov/food/enforcement.json?search=x',
  confidence: 'verified',
});

const render = async (recall: unknown) => {
  const container = await AstroContainer.create();
  return container.renderToString(RecallRow, { props: { recall } });
};

describe('Recall row rendering', () => {
  it('falls back to the verbatim product when there is no display name', async () => {
    const html = await render(base);
    expect(html).toContain('Grade A Brown In-shell Chicken eggs');
  });

  it('uses the short display name as the heading when present', async () => {
    const html = await render({ ...base, displayName: 'eggs' });
    expect(html).toMatch(/<h2[^>]*>eggs<\/h2>/);
  });

  it('NEVER shows the display name as the only identifier', async () => {
    // docs/design.md §2.1 rule 1. A category name alone ("eggs") reads as every
    // egg on the shelf; the specific product must stay on the page beside it.
    const html = await render({ ...base, displayName: 'eggs' });
    expect(html).toContain('Simple Truth');
    expect(html).toContain('UPC 0 11110-87032 0');
  });

  it('keeps the verbatim government reason visible with no voice', async () => {
    const html = await render(base);
    expect(html).toContain('Products may be contaminated with Salmonella.');
  });

  it('always renders a citation', async () => {
    const html = await render(base);
    expect(html).toContain('api.fda.gov');
  });

  it('shows nationwide rather than an empty state list', async () => {
    const html = await render({ ...base, states: [], nationwide: true });
    expect(html).toContain('Nationwide');
  });

  it('labels a Public Health Alert as such, not as a recall', async () => {
    const html = await render({ ...base, classification: 'Public Health Alert', source: 'fsis' });
    expect(html).toContain('Public Health Alert');
  });
});
