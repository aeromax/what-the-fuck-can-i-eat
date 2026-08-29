import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import {
  FdaRssFeed,
  FsisRecord,
  FsisResponse,
  OpenFdaResponse,
  PressReleaseFacts,
} from '../scripts/sourceSchemas.ts';
import { Classification, RecallSchema, makeId, slugFromUrl } from '../src/recall.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

// All fixtures were captured live on 2026-08-29. Nothing here touches the
// network; `npm run test` must pass with the machine offline.

describe('openFDA', () => {
  const parsed = OpenFdaResponse.parse(json('openfda-enforcement.json'));

  it('round-trips the captured response', () => {
    expect(parsed.results.length).toBe(43);
    expect(parsed.meta.results.total).toBe(43);
  });

  it('emits dates as YYYYMMDD strings, not ISO and not numbers', () => {
    for (const r of parsed.results) expect(r.report_date).toMatch(/^\d{8}$/);
  });

  it('carries lot codes as a structured column', () => {
    // This is why openFDA records never need model extraction: code_info is a
    // real field, so lot codes reach the page on the verified tier.
    expect(parsed.results.some((r) => r.code_info.trim() !== '')).toBe(true);
  });

  it('does not distinguish human from pet food via product_type', () => {
    // Every record says "Food". The pet-food filter in docs/design.md §7 cannot
    // be implemented against this field — see the RSS block below for where the
    // discriminator actually lives.
    expect([...new Set(parsed.results.map((r) => r.product_type))]).toEqual(['Food']);
  });

  it('emits distribution_pattern in mutually incompatible shapes', () => {
    // Pins the normalisation hazard in docs/design.md §4: the same field is
    // sometimes 2-letter codes, sometimes full state names, sometimes prose
    // with a "distributed to the following states:" preamble and "&" separators.
    const p = parsed.results.map((r) => r.distribution_pattern);
    expect(p.some((s) => /\b[A-Z]{2}\b/.test(s))).toBe(true);
    expect(p.some((s) => /Arkansas|Louisiana|California|Texas/.test(s))).toBe(true);
    expect(p.some((s) => /following states/i.test(s))).toBe(true);
  });
});

describe('FDA RSS', () => {
  // The exact parser config from docs/design.md §4.
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (n) => n === 'item',
  });

  it('round-trips the captured feed', () => {
    const feed = FdaRssFeed.parse(parser.parse(fixture('fda-rss.xml')));
    expect(feed.rss.channel.item.length).toBe(20);
  });

  it('keeps a single-item feed an array', () => {
    // Without `isArray`, this deserialises to an object and the schema rejects
    // it. That silent shape change is the trap this config exists to prevent.
    const feed = FdaRssFeed.parse(parser.parse(fixture('fda-rss-single-item.xml')));
    expect(feed.rss.channel.item.length).toBe(1);
  });

  it('carries pubDate with an alphabetic timezone', () => {
    const feed = FdaRssFeed.parse(parser.parse(fixture('fda-rss.xml')));
    // `new Date()` is not guaranteed to parse US zone abbreviations, so the
    // source module must parse this deliberately rather than trusting Date.
    expect(feed.rss.channel.item[0]!.pubDate).toMatch(/\b(EDT|EST)\b/);
  });

  it('carries pet food, which openFDA did not', () => {
    const feed = FdaRssFeed.parse(parser.parse(fixture('fda-rss.xml')));
    const petish = feed.rss.channel.item.filter((i) =>
      /pet food|feline|canine/i.test(i.title),
    );
    expect(petish.length).toBeGreaterThan(0);
  });
});

describe('FDA press release', () => {
  // Minimal <dl> reader, sufficient to pin the shape. The real parser is step 4.
  const dlText = (html: string) => {
    const dl = html.match(/<dl[\s\S]*?<\/dl>/)?.[0] ?? '';
    return dl.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  };

  it('repeats each label inside its own value', () => {
    // The brand cell literally reads "Brand Name(s) Donutful". A parser that
    // takes the <dd> verbatim publishes the label as part of the brand.
    expect(dlText(fixture('press-release-donutful.html'))).toContain('Brand Name(s) Donutful');
  });

  it('exposes the facts the model is never allowed to supply', () => {
    const t = dlText(fixture('press-release-donutful.html'));
    const facts = PressReleaseFacts.parse({
      companyName: 'The Better Bakehouse Snack Company',
      brandName: 'Donutful',
      productDescription: 'Chocolate Dipped Vanilla Cake Donuts',
      reason: 'Undeclared milk allergen',
      companyAnnouncementDate: 'August 24, 2026',
      productType: 'Food & Beverages Allergens',
    });
    // Each asserted fact is present in the page, so none of them requires a model.
    for (const v of Object.values(facts)) expect(t).toContain(v.split(' & ')[0]!);
  });

  it('discriminates pet food structurally via Product Type', () => {
    const human = dlText(fixture('press-release-donutful.html'));
    const pet = dlText(fixture('press-release-petfood.html'));

    expect(pet).toContain('Animal & Veterinary');
    expect(human).not.toContain('Animal & Veterinary');

    // Both contain "Food & Beverages", so the rule must be exclude-on-Animal.
    // An include-on-Food rule would let every pet recall through.
    expect(pet).toContain('Food & Beverages');
    expect(human).toContain('Food & Beverages');
  });
});

describe('FSIS', () => {
  const records = FsisResponse.parse(json('fsis-recalls.json'));

  it('round-trips the captured response', () => {
    expect(records.length).toBe(15);
  });

  it('duplicates recalls across langcodes', () => {
    // Filtering to English is what stops every meat recall rendering twice.
    const english = records.filter((r) => r.langcode === 'English');
    expect(records.length).toBeGreaterThan(english.length);
    expect(new Set(english.map((r) => r.field_recall_number)).size).toBe(english.length);
  });

  it('accepts both the array and legacy comma-joined shapes', () => {
    const legacy = FsisRecord.parse(json('fsis-legacy-string-shape.json')[0]);
    expect(legacy.field_states).toEqual([
      'Maine',
      'Massachusetts',
      'New Hampshire',
      'Rhode Island',
      'Vermont',
    ]);
    // Both shapes normalise to the same thing, so downstream code sees arrays only.
    expect(Array.isArray(records[0]!.field_states)).toBe(true);
  });

  it('emits full state names, unlike openFDA', () => {
    const withStates = records.find((r) => r.field_states.length > 0)!;
    expect(withStates.field_states.every((s) => s.length > 2)).toBe(true);
  });

  it('carries a classification outside the Class I/II/III scheme', () => {
    // "Public Health Alert" is not a recall class. It is included on purpose —
    // see docs/design.md §7 — so the source module must pass it through rather
    // than dropping it as unrecognised.
    const all = new Set(records.map((r) => r.field_recall_classification));
    expect([...all]).toContain('Public Health Alert');
    expect(Classification.safeParse('Public Health Alert').success).toBe(true);
  });

  it('cannot use field_active_notice as the inclusion filter', () => {
    // Live data has exactly ONE record flagged True across all 2,023 rows, so
    // filtering on it would publish a one-item page. Recency must come from
    // field_recall_date instead.
    const active = records.filter((r) => r.field_active_notice === 'True');
    expect(active.length).toBeLessThan(records.length);
  });
});

describe('Recall model', () => {
  const valid = {
    id: 'openfda:h-1219-2026',
    product: 'Selectos Latinos Requeson Mexicano Mexican Cottage Cheese',
    brand: 'Selectos Latinos',
    company: 'La Colonia Foods Llc',
    reason: 'Products may be contaminated with Listeria monocytogenes.',
    announcedDate: '2026-08-12',
    classification: 'Class I',
    retailers: [],
    states: ['Maryland', 'Virginia'],
    countryOfOrigin: null,
    lotCodes: ['Selec1011'],
    source: 'openfda',
    sourceUrl: 'https://api.fda.gov/food/enforcement.json?search=recall_number:%22H-1219-2026%22',
    confidence: 'verified',
    headline: null,
    avoidLine: null,
  };

  it('accepts a well-formed record', () => {
    expect(RecallSchema.parse(valid).id).toBe('openfda:h-1219-2026');
  });

  it('requires a sourceUrl on every record', () => {
    // Every record must cite the government page it came from — docs/design.md §2.
    const { sourceUrl: _, ...without } = valid;
    expect(RecallSchema.safeParse(without).success).toBe(false);
    expect(RecallSchema.safeParse({ ...valid, sourceUrl: 'not-a-url' }).success).toBe(false);
  });

  it('rejects Class III and unclassified records', () => {
    for (const c of ['Class III', 'Not Yet Classified', '']) {
      expect(RecallSchema.safeParse({ ...valid, classification: c }).success).toBe(false);
    }
  });

  it('accepts a Public Health Alert', () => {
    // Decision 2026-08-29: included as the safer reading of the inclusion rule.
    // A PHA means contaminated product is believed to be in commerce with no
    // recall requested — by this page's standard that is at least as urgent as
    // a Class II. docs/design.md §7.
    const pha = { ...valid, classification: 'Public Health Alert', source: 'fsis' };
    expect(RecallSchema.parse(pha).classification).toBe('Public Health Alert');
  });

  it('requires a non-empty verbatim reason', () => {
    expect(RecallSchema.safeParse({ ...valid, reason: '' }).success).toBe(false);
  });

  it('defaults voice fields to null so voice.ts can find ungenerated records', () => {
    const { headline: _h, avoidLine: _a, ...bare } = valid;
    const parsed = RecallSchema.parse(bare);
    // "Never regenerate existing voice" depends on this being reliably absent.
    expect(parsed.headline).toBeNull();
    expect(parsed.avoidLine).toBeNull();
  });

  it('demands ISO dates, rejecting both upstream formats', () => {
    expect(RecallSchema.safeParse({ ...valid, announcedDate: '20260812' }).success).toBe(false);
    expect(
      RecallSchema.safeParse({ ...valid, announcedDate: 'Wed, 12 Aug 2026 16:43:00 EDT' }).success,
    ).toBe(false);
  });
});

describe('id derivation', () => {
  it('namespaces by source', () => {
    expect(makeId('openfda', 'H-1219-2026')).toBe('openfda:h-1219-2026');
    expect(makeId('fsis', '018-2026')).toBe('fsis:018-2026');
  });

  it('keeps same-shaped keys from different sources distinct', () => {
    // openFDA and FSIS recall numbers can collide in shape while meaning
    // different recalls, so ids must never be compared across sources.
    expect(makeId('openfda', '018-2026')).not.toBe(makeId('fsis', '018-2026'));
  });

  it('is stable across runs for the same input', () => {
    expect(makeId('fsis', ' 018-2026 ')).toBe(makeId('fsis', '018-2026'));
  });

  it('derives an RSS id from the press-release slug', () => {
    const url =
      'http://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/better-bakehouse-snack-company-recalling-certain-lots-donutful-chocolate-dipped-vanilla-cake-donuts';
    expect(makeId('fdaRss', slugFromUrl(url))).toBe(
      'fdaRss:better-bakehouse-snack-company-recalling-certain-lots-donutful-chocolate-dipped-vanilla-cake-donuts',
    );
  });

  it('refuses an empty key rather than minting a collidable id', () => {
    expect(() => makeId('openfda', '   ')).toThrow();
  });
});
