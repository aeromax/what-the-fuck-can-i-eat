import { writeFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type { z } from 'zod';
import type { Recall } from '../../src/recall.ts';
import { normalizeFdaRss } from '../normalize.ts';
import { fetchPressRelease, isHumanFood, parsePressRelease } from '../pressRelease.ts';
import { FdaRssFeed, type FdaRssItem } from '../sourceSchemas.ts';

export type FdaRssItemT = z.infer<typeof FdaRssItem>;

export const FEED_URL =
  'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/food-safety-recalls/rss.xml';

/**
 * `isArray` is load-bearing: without it a single-item feed deserialises to an
 * object instead of a one-element array, and every downstream `.map` silently
 * sees nothing. docs/design.md §4.
 */
export const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === 'item',
});

/**
 * US timezone abbreviations are not reliably parsed by `new Date()` across
 * runtimes — it is implementation-defined, and a wrong guess silently shifts a
 * recall a day in or out of the 30-day window. The feed only ever uses Eastern,
 * so the two offsets are spelled out rather than inferred.
 */
const ZONES: Record<string, string> = { EDT: '-04:00', EST: '-05:00' };

export function parsePubDate(pubDate: string): Date | null {
  const m = pubDate.match(/^\w{3},\s*(\d{1,2})\s+(\w{3})\s+(\d{4})\s+([\d:]+)\s+(\w+)$/);
  if (!m) return null;
  const [, day, mon, year, time, zone] = m;

  const offset = ZONES[zone!];
  if (!offset) return null;

  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const month = months.indexOf(mon!) + 1;
  if (month === 0) return null;

  const d = new Date(
    `${year}-${String(month).padStart(2, '0')}-${day!.padStart(2, '0')}T${time}${offset}`,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface RssResult {
  items: FdaRssItemT[];
  reachable: boolean;
  note: string;
}

/**
 * Fetches and parses the feed. Never throws — a failing source degrades rather
 * than blanking the page (docs/design.md §6).
 */
export async function fetchFdaRss(): Promise<RssResult> {
  let raw: string;
  let contentType: string;
  try {
    const res = await fetch(FEED_URL);
    if (!res.ok) return { items: [], reachable: false, note: `HTTP ${res.status}` };
    contentType = res.headers.get('content-type') ?? '';
    raw = await res.text();
  } catch (e) {
    return { items: [], reachable: false, note: (e as Error).message };
  }

  // A wrong-but-plausible feed URL returns a 404 HTML page that deserialises to
  // garbage rather than throwing, so a 200 is not enough. docs/design.md §4.
  if (!/xml/i.test(contentType)) {
    return { items: [], reachable: false, note: `unexpected content-type: ${contentType}` };
  }

  writeFileSync(new URL('../../data/snapshots/fda-rss.xml', import.meta.url), raw);

  const parsed = FdaRssFeed.safeParse(parser.parse(raw));
  if (!parsed.success) {
    return { items: [], reachable: false, note: `schema rejected: ${parsed.error.message}` };
  }

  const items = parsed.data.rss.channel.item;
  return {
    items,
    reachable: true,
    note: items.length === 0 ? 'WARNING: feed parsed but contained no items' : `${items.length} items`,
  };
}

/** Items announced within the window, newest first. */
export function selectRecent(items: FdaRssItemT[], now = new Date(), days = 30): FdaRssItemT[] {
  const cutoff = now.getTime() - days * 864e5;
  return items
    .map((item) => ({ item, at: parsePubDate(item.pubDate) }))
    .filter((x) => x.at !== null && x.at.getTime() >= cutoff)
    .sort((a, b) => b.at!.getTime() - a.at!.getTime())
    .map((x) => x.item);
}

export interface RssRecallsResult {
  recalls: Recall[];
  reachable: boolean;
  note: string;
  /** Items skipped, by reason — surfaced so silent losses stay visible. */
  skipped: { petFood: number; unparseable: number; unreachable: number };
}

/**
 * The whole RSS path: feed -> recent items -> one press-release fetch each ->
 * <dl> parse -> pet-food filter -> extracted-tier Recall.
 *
 * Pages are fetched one at a time rather than in parallel. This is a government
 * server being read by a scheduled job four times a day; there is no deadline
 * worth hammering it for.
 */
export async function fetchFdaRssRecalls(now = new Date()): Promise<RssRecallsResult> {
  const skipped = { petFood: 0, unparseable: 0, unreachable: 0 };
  const feed = await fetchFdaRss();
  if (!feed.reachable) return { recalls: [], reachable: false, note: feed.note, skipped };

  const recalls: Recall[] = [];
  for (const item of selectRecent(feed.items, now)) {
    const html = await fetchPressRelease(item.link);
    if (html === null) {
      skipped.unreachable += 1;
      continue;
    }

    const facts = parsePressRelease(html);
    if (facts === null) {
      skipped.unparseable += 1;
      continue;
    }

    // Pet food is excluded here, not upstream: openFDA cannot distinguish it and
    // the RSS title is unreliable. The press release says so structurally.
    if (!isHumanFood(facts)) {
      skipped.petFood += 1;
      continue;
    }

    recalls.push(normalizeFdaRss(item.link, facts));
  }

  const note =
    recalls.length === 0
      ? `WARNING: RSS yielded no usable records from ${feed.items.length} feed items`
      : `${recalls.length} records; skipped ${skipped.petFood} pet, ${skipped.unparseable} unparseable, ${skipped.unreachable} unreachable`;

  return { recalls, reachable: true, note, skipped };
}
