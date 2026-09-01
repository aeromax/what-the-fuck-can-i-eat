import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePubDate, parser, selectRecent } from '../scripts/sources/fdaRss.ts';
import { factsBlock, isHumanFood, parsePressRelease, readPairs } from '../scripts/pressRelease.ts';
import { normalizeFdaRss } from '../scripts/normalize.ts';
import { FdaRssFeed } from '../scripts/sourceSchemas.ts';
import { RecallSchema } from '../src/recall.ts';

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const feed = FdaRssFeed.parse(parser.parse(fixture('fda-rss.xml')));
const items = feed.rss.channel.item;

describe('RSS parsing', () => {
  it('keeps a single-item feed as an array', () => {
    const one = FdaRssFeed.parse(parser.parse(fixture('fda-rss-single-item.xml')));
    expect(one.rss.channel.item).toHaveLength(1);
  });

  it('parses the alphabetic EDT zone deliberately', () => {
    const d = parsePubDate('Mon, 24 Aug 2026 20:36:00 EDT');
    expect(d).not.toBeNull();
    // 20:36 EDT is 00:36 UTC the next day. Getting this wrong shifts records
    // across the 30-day boundary.
    expect(d!.toISOString()).toBe('2026-08-25T00:36:00.000Z');
  });

  it('handles EST as well as EDT', () => {
    expect(parsePubDate('Mon, 12 Jan 2026 10:00:00 EST')!.toISOString()).toBe(
      '2026-01-12T15:00:00.000Z',
    );
  });

  it('refuses a zone it does not know rather than guessing', () => {
    // Silently mis-parsing a zone is worse than dropping the item, because the
    // item still renders with a wrong date.
    expect(parsePubDate('Mon, 24 Aug 2026 20:36:00 PDT')).toBeNull();
    expect(parsePubDate('not a date')).toBeNull();
  });

  it('parses every pubDate in the captured feed', () => {
    for (const item of items) expect(parsePubDate(item.pubDate)).not.toBeNull();
  });

  it('filters to the 30-day window', () => {
    const recent = selectRecent(items, new Date('2026-08-29T00:00:00Z'));
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.length).toBeLessThanOrEqual(items.length);
    // Newest first.
    const dates = recent.map((i) => parsePubDate(i.pubDate)!.getTime());
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });
});

describe('press-release <dl> parsing', () => {
  const donutful = parsePressRelease(fixture('press-release-donutful.html'))!;

  it('finds the facts block and not the contact blocks', () => {
    const dl = factsBlock(fixture('press-release-donutful.html'))!;
    const labels = readPairs(dl).map((p) => p.label);
    expect(labels).toContain('Company Name');
    // The page carries Consumers: and Media: phone-number lists too.
    expect(labels).not.toContain('Consumers');
    expect(labels).not.toContain('Media');
  });

  it('strips the label the <dd> repeats inside itself', () => {
    // Raw text reads "Brand Name(s) Donutful"; parsing the element rather than
    // the string is what makes this exact.
    expect(donutful.brandName).toBe('Donutful');
    expect(donutful.brandName).not.toContain('Brand Name');
  });

  it('extracts every field the model is forbidden to write', () => {
    expect(donutful.companyName).toBe('The Better Bakehouse Snack Company');
    expect(donutful.productDescription).toBe('Chocolate Dipped Vanilla Cake Donuts');
    expect(donutful.reason).toBe('Undeclared milk allergen');
  });

  it('reads the announcement date in US Eastern, not UTC', () => {
    // The <time datetime> is 2026-08-25T00:36:00Z, but the page says August 24.
    // Taking the UTC date would misdate the record and shift the 30-day window.
    expect(donutful.companyAnnouncementDate).toBe('2026-08-24');
  });

  it('excludes pet food on Animal & Veterinary, not on absence of Food', () => {
    const pet = parsePressRelease(fixture('press-release-petfood.html'))!;
    expect(isHumanFood(donutful)).toBe(true);
    expect(isHumanFood(pet)).toBe(false);
    // The trap: the pet page contains "Food & Beverages" too, so an
    // include-on-Food rule would admit it.
    expect(pet.productType).toContain('Food & Beverages');
  });

  it('returns null rather than a half-parsed record', () => {
    expect(parsePressRelease('<html><body>no dl here</body></html>')).toBeNull();
  });
});

describe('normalizing to the extracted tier', () => {
  const link =
    'http://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/better-bakehouse-snack-company-recalling-certain-lots-donutful-chocolate-dipped-vanilla-cake-donuts';
  const facts = parsePressRelease(fixture('press-release-donutful.html'))!;
  const recall = normalizeFdaRss(link, facts);

  it('produces a schema-valid extracted record', () => {
    expect(RecallSchema.safeParse(recall).success).toBe(true);
    expect(recall.confidence).toBe('extracted');
  });

  it('keeps reason byte-identical to the government text', () => {
    expect(recall.reason).toBe(facts.reason);
  });

  it('leaves the prose fields empty for step 7', () => {
    // These are the only fields a model may ever fill, and it has not run yet.
    expect(recall.retailers).toEqual([]);
    expect(recall.states).toEqual([]);
    expect(recall.lotCodes).toEqual([]);
    expect(recall.countryOfOrigin).toBeNull();
  });

  it('records no classification rather than inventing one', () => {
    // FDA assigns Class I/II weeks later. Null is honest; guessing is not.
    expect(recall.classification).toBeNull();
  });

  it('cites the press release over https', () => {
    expect(recall.sourceUrl.startsWith('https://')).toBe(true);
    expect(recall.sourceUrl).toContain('fda.gov');
  });

  it('has no voice yet', () => {
    expect(recall.headline).toBeNull();
    expect(recall.displayName).toBeNull();
  });
});

describe('RSS empty feed is empty, not unreachable', () => {
  it('parses a feed with no items to an empty array', () => {
    // fast-xml-parser omits `item` entirely when the channel has none. Without
    // the schema default that rejected, and `fetchFdaRss` reported the source
    // as unreachable — hiding a genuine zero behind a network-failure shape and
    // skipping refresh's loud "reachable but zero" warning.
    const xml =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Food Safety Recalls</title></channel></rss>';
    const parsed = FdaRssFeed.parse(parser.parse(xml));
    expect(parsed.rss.channel.item).toEqual([]);
  });
});
