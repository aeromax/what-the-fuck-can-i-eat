// Writes data/recalls.json from the sources that exist so far, so `npm run dev`
// and `npm run preview` have something real to render.
//
// This is NOT the pipeline — that is scripts/refresh.ts at step 8, which also
// merges, generates voice, and refuses to commit a no-op run. This script only
// fetches and normalizes, and every record it writes has headline: null, so the
// page renders through the documented no-voice fallback (docs/design.md §6).
//
// Nothing here is fabricated. Fake recall rows are never written to this repo:
// the page exists to tell people what not to eat, and invented rows in the
// published state file are the one kind of placeholder that could do harm.

import { writeFileSync } from 'node:fs';
import { fetchFdaRssRecalls } from './sources/fdaRss.ts';
import { fetchOpenFda } from './sources/openfda.ts';

const out = new URL('../data/recalls.json', import.meta.url);

const openfda = await fetchOpenFda();
console.log(`openFDA: reachable=${openfda.reachable} — ${openfda.note}`);

const rss = await fetchFdaRssRecalls();
console.log(`FDA RSS: reachable=${rss.reachable} — ${rss.note}`);

if (!openfda.reachable && !rss.reachable) {
  // Degrade, never blank: leave whatever is already committed in place.
  console.error('all sources unreachable; leaving data/recalls.json untouched.');
  process.exit(1);
}

// NOT merged. merge.ts is step 6, so a recall that appears in both openFDA and
// RSS shows up twice here. That is the honest preview of an unmerged pipeline,
// and duplicate rows are the cheap failure the merge rules are designed around
// (docs/design.md §6) — better visible here than papered over.
const recalls = [...openfda.recalls, ...rss.recalls].sort((a, b) =>
  a.announcedDate === b.announcedDate
    ? a.id.localeCompare(b.id)
    : b.announcedDate.localeCompare(a.announcedDate),
);

writeFileSync(out, `${JSON.stringify(recalls, null, 2)}\n`);
console.log(`wrote ${recalls.length} records to data/recalls.json`);
console.log(`  ${recalls.filter((r) => r.headline === null).length} awaiting voice (step 7)`);
console.log(`  ${recalls.filter((r) => r.confidence === 'verified').length} verified, ${recalls.filter((r) => r.confidence === 'extracted').length} extracted`);
console.log('  NOT deduped — merge.ts is step 6.');
