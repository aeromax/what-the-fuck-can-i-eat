/**
 * All dates on this page are US Eastern, labelled.
 *
 * A note on "EST": the request was to default everything to EST and say so.
 * This formats in the `America/New_York` ZONE and prints whichever abbreviation
 * is actually correct for that date — EDT from March to November, EST otherwise.
 *
 * Pinning a fixed UTC-5 offset year-round would be wrong for roughly eight
 * months of the year, and wrong in a way that moves calendar dates: a recall
 * announced at 00:30 EDT would render as the previous day, which is the exact
 * off-by-one that the <time datetime> UTC bug already caused once. Since these
 * records drive a 30-day window, a shifted date can also add or drop an item.
 *
 * So: one zone, always Eastern, always labelled — but the label tells the truth
 * about which half of the year it is.
 */

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const ZONE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

/** Midday UTC keeps the calendar date stable when converting a bare ISO day. */
function instantFor(isoDay: string): Date {
  return new Date(`${isoDay}T12:00:00Z`);
}

export interface EasternDate {
  /** e.g. "Aug 24, 2026" */
  text: string;
  /** "EDT" or "EST", correct for that date. */
  zone: string;
}

export function formatEastern(isoDay: string): EasternDate {
  const at = instantFor(isoDay);
  if (Number.isNaN(at.getTime())) return { text: isoDay, zone: 'ET' };

  const zone = ZONE.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'ET';
  return { text: DAY.format(at), zone };
}
