import { Impit } from 'impit';
import { z } from 'zod';
import { PressReleaseFacts } from './sourceSchemas.ts';

// Parses the facts <dl> of one FDA press-release page.
//
// NOTHING here involves a model. These are the fields docs/design.md §2 forbids
// the model from ever supplying: brand, company, product, reason and dates. If
// this parser breaks, fix the parser — do not widen the model's surface to cover
// for it.

export type PressReleaseFactsT = z.infer<typeof PressReleaseFacts>;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, '’');

const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * The facts live in the grid <dl>. The page carries two more — `Consumers:` and
 * `Media:` — holding phone numbers, which must not be mistaken for product data.
 */
export function factsBlock(html: string): string | null {
  for (const dl of html.match(/<dl[\s\S]*?<\/dl>/g) ?? []) {
    if (dl.includes('lcds-description-list--grid')) return dl;
  }
  return null;
}

/**
 * Reads one <dd>.
 *
 * The `<dd>` repeats its own label as a `<div class="field--label">` child — the
 * quirk that makes the brand cell read "Brand Name(s) Donutful" once tags are
 * stripped. CLAUDE.md describes fixing that by stripping a duplicated string
 * prefix; parsing the element is strictly better, because it cannot damage a
 * value that legitimately begins with its own label text.
 *
 * Values may arrive as one or more `field--item` divs, or as bare text.
 */
function readValue(dd: string): string[] {
  const withoutLabels = dd.replace(/<div class="field--label">[\s\S]*?<\/div>/g, '');

  const items = [...withoutLabels.matchAll(/<div class="field--item">([\s\S]*?)<\/div>/g)]
    .map((m) => stripTags(m[1]!))
    .filter(Boolean);
  if (items.length > 0) return items;

  // No field wrapper: split on <br/>, which is how Product Type carries several
  // values in one cell ("Food & Beverages" + "Allergens").
  return withoutLabels
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(Boolean);
}

/**
 * Prefers the machine-readable <time datetime>, falling back to the shown text.
 *
 * The datetime attribute is UTC, and FDA announcements are timestamped US
 * Eastern — so an evening announcement carries a UTC instant on the FOLLOWING
 * day. Slicing the ISO string directly reads "August 24, 2026" as 2026-08-25,
 * which both misdates the record on the page and shifts it inside the 30-day
 * window. Convert to Eastern before taking the calendar date.
 */
const EASTERN = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function easternDate(instant: Date): string {
  return EASTERN.format(instant); // en-CA renders ISO-shaped YYYY-MM-DD
}

function readDate(dd: string): string {
  const iso = dd.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return easternDate(d);
  }
  return stripTags(dd);
}

/** dt/dd pairs of one <dl>, in document order. */
export function readPairs(dl: string): Array<{ label: string; raw: string }> {
  const pairs: Array<{ label: string; raw: string }> = [];
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g;
  for (const m of dl.matchAll(re)) {
    pairs.push({ label: stripTags(m[1]!).replace(/:$/, ''), raw: m[2]! });
  }
  return pairs;
}

/**
 * Parses the facts block into the fields the model may never write.
 * Returns null when the block is missing or unrecognisable — the caller drops
 * the item rather than publishing a half-parsed record.
 */
export function parsePressRelease(html: string): PressReleaseFactsT | null {
  const dl = factsBlock(html);
  if (!dl) return null;

  const byLabel = new Map<string, string>();
  for (const { label, raw } of readPairs(dl)) byLabel.set(label, raw);

  const get = (label: string) => byLabel.get(label);
  const text = (label: string) => {
    const raw = get(label);
    return raw === undefined ? undefined : readValue(raw).join(' ');
  };

  const companyName = text('Company Name');
  const productDescription = text('Product Description');
  const reason = text('Reason for Announcement');
  const announcement = get('Company Announcement Date');

  if (!companyName || !productDescription || !reason || !announcement) return null;

  const parsed = PressReleaseFacts.safeParse({
    companyName,
    brandName: text('Brand Name') ?? '',
    productDescription,
    reason,
    companyAnnouncementDate: readDate(announcement),
    productType: text('Product Type') ?? '',
  });

  return parsed.success ? parsed.data : null;
}

/**
 * The pet-food filter (docs/design.md §4).
 *
 * Exclude on "Animal & Veterinary", never include on "Food & Beverages": pet
 * pages carry BOTH strings, so an include-rule admits every pet recall.
 */
export function isHumanFood(facts: PressReleaseFactsT): boolean {
  return !/animal\s*&\s*veterinary/i.test(facts.productType);
}

/**
 * Fetches one announcement page. Returns null on any failure, including a
 * non-HTML response — the caller skips the item rather than publishing a
 * record built from a 404 page.
 *
 * Via impit for the same proven reason as the feed (scripts/sources/fdaRss.ts):
 * www.fda.gov serves plain fetch() from a GitHub runner a 10-byte `Not found\n`
 * 404 with no content-type, on announcement pages as well as the feed, while
 * impit gets 200 and a 49,882-byte page. Run 33543434214 measured both, on the
 * https URL this function actually requests rather than the http:// one the
 * feed advertises. Swapping the feed alone would have left every item skipped
 * as unreachable.
 */
export async function fetchPressRelease(url: string): Promise<string | null> {
  try {
    const res = await new Impit({ browser: 'chrome' }).fetch(url.replace(/^http:\/\//, 'https://'));
    if (!res.ok) return null;
    if (!/html/i.test(res.headers.get('content-type') ?? '')) return null;
    return await res.text();
  } catch {
    return null;
  }
}
