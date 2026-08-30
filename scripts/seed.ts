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
import { createGeminiClient } from './gemini.ts';
import { fetchPressRelease } from './pressRelease.ts';
import { applyVoice } from './voice.ts';
import { mergeRecalls } from './merge.ts';
import { fetchFdaRssRecalls } from './sources/fdaRss.ts';
import { fetchFsis } from './sources/fsis.ts';
import { fetchOpenFda } from './sources/openfda.ts';

const out = new URL('../data/recalls.json', import.meta.url);
const reviewOut = new URL('../data/review.json', import.meta.url);

const openfda = await fetchOpenFda();
console.log(`openFDA: reachable=${openfda.reachable} — ${openfda.note}`);

const rss = await fetchFdaRssRecalls();
console.log(`FDA RSS: reachable=${rss.reachable} — ${rss.note}`);

const fsis = await fetchFsis();
console.log(`FSIS:    reachable=${fsis.reachable} — ${fsis.note}`);

if (!openfda.reachable && !rss.reachable && !fsis.reachable) {
  // Degrade, never blank: leave whatever is already committed in place.
  console.error('all sources unreachable; leaving data/recalls.json untouched.');
  process.exit(1);
}

const fetched = [...openfda.recalls, ...rss.recalls, ...fsis.recalls];
const { recalls, review, mergedCount } = mergeRecalls(fetched);

// Voice runs only when a key is present. Without one the seed still writes a
// complete, publishable file — every record keeps its plain product name and
// verbatim government reason, which is the same fallback a Gemini outage
// produces (docs/design.md §6). The preview is honest either way.
const apiKey = process.env.GEMINI_API_KEY ?? '';
let voiced = recalls;

if (apiKey === '') {
  console.log('\nGEMINI_API_KEY not set — skipping voice. Records publish with');
  console.log('their government reason, exactly as they would during an outage.');
} else {
  const outcome = await applyVoice(recalls, {
    client: createGeminiClient(apiKey),
    // Only the cited government page for THIS record is ever fetched, and only
    // for records that need extraction. docs/design.md §2: one page per call.
    fetchPageText: (recall) => fetchPressRelease(recall.sourceUrl),
    onWarn: (message) => console.warn(`  voice: ${message}`),
  });
  voiced = outcome.recalls;
  console.log(`\nvoice: ${outcome.voiced} voiced, ${outcome.enriched} enriched, ${outcome.failed} fell back`);
  if (outcome.dropped.length > 0) {
    console.log(`  dropped ${outcome.dropped.length} extracted values not found in their source page`);
  }
}

writeFileSync(out, `${JSON.stringify(voiced, null, 2)}\n`);
// Ambiguous pairs go to a human, and BOTH records stay published — a duplicate
// row is cheap, a wrong merge is not (docs/design.md §6).
writeFileSync(reviewOut, `${JSON.stringify(review, null, 2)}\n`);

console.log(`wrote ${voiced.length} records to data/recalls.json`);
console.log(`  ${fetched.length} fetched, ${mergedCount} merged away`);
console.log(`  ${voiced.filter((r) => r.headline === null).length} awaiting voice`);
console.log(`  ${voiced.filter((r) => r.confidence === 'verified').length} verified, ${voiced.filter((r) => r.confidence === 'extracted').length} extracted`);
if (review.length > 0) {
  console.log(`  ${review.length} ambiguous pair(s) in data/review.json — both records still published`);
  for (const entry of review) {
    console.log(`    ${entry.why}: ${entry.records.map((r) => r.id).join('  <->  ')}`);
  }
} else {
  console.log('  0 ambiguous pairs');
}
