// Production entry point for the data pipeline. Wires steps 3–7 together and
// enforces the invariants that make the four-times-a-day cron safe.
//
// Design decisions worth calling out, because "how did you decide" is the first
// question when something goes wrong:
//
//   • Meta lives in a sibling `data/meta.json` as `{ sources: [...] }`. Two
//     reasons over extending `recalls.json` with a top-level object: the current
//     page (step 9 will replace it) imports `recalls.json` as a plain Recall[],
//     so changing that shape breaks the preview until step 9 lands; and keeping
//     the payload separate lets the byte-identical check treat facts and
//     footer-metadata under one rule, without either dragging the other into a
//     spurious diff. Step 9 consumes `data/meta.json` for the "which sources
//     were reachable" footer.
//
//   • No `lastChecked` timestamp is written into `meta.json`. If we did, every
//     run would tick it and every run would commit — which is the exact rule
//     this step exists to enforce against. The page's "last checked" line reads
//     the file mtime / git commit timestamp instead, both of which move only
//     when the data actually moves.
//
//   • Byte-identical comparison is `JSON.stringify(x, null, 2) + '\n'` against
//     the file on disk. Schemas have fixed key order, so this is stable.
//
//   • Degrade-never-blank: if the fresh pipeline produces zero records for any
//     reason, `data/recalls.json` is not overwritten. Last-good stays on disk
//     and refresh exits non-zero so CI notices.
//
//   • Sources handle their own snapshots (already do — `scripts/sources/*.ts`
//     writes to `data/snapshots/` in place). Refresh does not duplicate that.
//
//   • Voice call for a record that already has a headline is skipped by
//     `applyVoice` itself, but only if `carryVoiceForward` was called first —
//     a fresh source fetch always looks entirely unvoiced. This was the exact
//     bug caught in build step 7; the test suite pins it.

import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Recall } from '../src/recall.ts';
import type { MetaFile, SourceReport } from '../src/meta.ts';
import { createGeminiClient } from './gemini.ts';
import { mergeRecalls, type ReviewEntry } from './merge.ts';
import { fetchPressRelease } from './pressRelease.ts';
import { fetchFdaRssRecalls } from './sources/fdaRss.ts';
import { fetchFsis } from './sources/fsis.ts';
import { fetchOpenFda } from './sources/openfda.ts';
import { applyVoice, carryVoiceForward } from './voice.ts';

// --- shared types -------------------------------------------------------------

/** What each source fetcher already returns; typed here so refresh does not
 * depend on the three near-identical structural shapes across the source files. */
export interface SourceOutcome {
  recalls: Recall[];
  reachable: boolean;
  note: string;
}

// `MetaFile`/`MetaSchema` moved to `src/meta.ts` so the page can validate
// `data/meta.json` without importing this module — refresh.ts transitively pulls
// in impit and the Gemini client, neither of which belongs on the render path.
// Re-exported here so refresh's own callers and tests keep one import site.
export { MetaSchema, SourceReportSchema } from '../src/meta.ts';
export type { MetaFile, SourceReport };

/** The voice step, injected so tests can drive it without touching Gemini. */
export type Voicer = (recalls: Recall[]) => Promise<Recall[]>;

export type FileName = 'recalls' | 'review' | 'meta';

export interface RefreshDeps {
  fetchOpenFda: () => Promise<SourceOutcome>;
  fetchFdaRss: () => Promise<SourceOutcome>;
  fetchFsis: () => Promise<SourceOutcome>;
  /** The committed recalls.json, deserialized. Used ONLY for carryVoiceForward. */
  loadCommittedRecalls: () => Recall[];
  /** The committed file text, byte-for-byte. Returns null if missing. */
  loadCommittedText: (name: FileName) => string | null;
  writeText: (name: FileName, text: string) => void;
  voice: Voicer;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface RefreshResult {
  /** 'wrote' — files updated. 'unchanged' — byte-identical, no writes.
   * 'refused-empty' — degrade-never-blank path, recalls.json left alone. */
  status: 'wrote' | 'unchanged' | 'refused-empty';
  meta: MetaFile;
  voiced: Recall[];
  review: ReviewEntry[];
}

// --- helpers ------------------------------------------------------------------

/** Stable serialization. Recall + Review + Meta all have deterministic key
 * order via Zod schemas or the plain-object constructor, so this is a
 * one-liner. Preserves the trailing newline the seed script established. */
export function stableSerialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function safeFetch(
  name: SourceReport['name'],
  fn: () => Promise<SourceOutcome>,
  warn: (m: string) => void,
): Promise<SourceOutcome> {
  // Source fetchers are already documented to never throw — they translate
  // every failure to `reachable: false`. This wrapper is belt-and-braces so a
  // regression in one source cannot abort the whole run.
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    warn(`${name} threw: ${message}`);
    return { recalls: [], reachable: false, note: `threw: ${message}` };
  }
}

// --- pipeline -----------------------------------------------------------------

export async function refresh(deps: RefreshDeps): Promise<RefreshResult> {
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  const [openfda, rss, fsis] = await Promise.all([
    safeFetch('openFDA', deps.fetchOpenFda, warn),
    safeFetch('FDA RSS', deps.fetchFdaRss, warn),
    safeFetch('FSIS', deps.fetchFsis, warn),
  ]);

  const reports: SourceReport[] = [
    { name: 'openFDA', reachable: openfda.reachable, note: openfda.note, count: openfda.recalls.length },
    { name: 'FDA RSS', reachable: rss.reachable, note: rss.note, count: rss.recalls.length },
    { name: 'FSIS', reachable: fsis.reachable, note: fsis.note, count: fsis.recalls.length },
  ];

  for (const r of reports) {
    log(`${r.name}: reachable=${r.reachable} count=${r.count} — ${r.note}`);
    // A silent zero from a reachable source is the failure mode named in
    // CLAUDE.md — FSIS going silent means meat and poultry recalls vanish
    // while the page still looks complete. Warn loudly.
    if (r.reachable && r.count === 0) {
      warn(`${r.name} reached but returned zero records — investigate before trusting this run`);
    }
  }

  const fetched = [...openfda.recalls, ...rss.recalls, ...fsis.recalls];
  const merged = mergeRecalls(fetched);
  log(`merge: ${fetched.length} fetched, ${merged.mergedCount} merged, ${merged.review.length} ambiguous pair(s)`);

  // MUST run before voice, or "never regenerate existing voice" cannot hold —
  // fresh source fetches always look entirely unvoiced. Build-step-7 bug.
  const previous = deps.loadCommittedRecalls();
  const withPriorVoice = carryVoiceForward(previous, merged.recalls);
  const carried = withPriorVoice.filter((r) => r.headline !== null).length;
  log(`carried voice forward for ${carried} of ${withPriorVoice.length} records`);

  const voiced = await deps.voice(withPriorVoice);

  const meta: MetaFile = { sources: reports };

  // Degrade, never blank. Empty output does not overwrite a good state file:
  // last-good stays on disk, exit non-zero, human comes and looks.
  if (voiced.length === 0) {
    error(
      'refused to publish an empty page — data/recalls.json left as-is. ' +
        `Sources: openFDA=${openfda.reachable}, FDA RSS=${rss.reachable}, FSIS=${fsis.reachable}.`,
    );
    return { status: 'refused-empty', meta, voiced, review: merged.review };
  }

  const nextRecalls = stableSerialize(voiced);
  const nextReview = stableSerialize(merged.review);
  const nextMeta = stableSerialize(meta);

  const prevRecalls = deps.loadCommittedText('recalls');
  const prevReview = deps.loadCommittedText('review');
  const prevMeta = deps.loadCommittedText('meta');

  if (nextRecalls === prevRecalls && nextReview === prevReview && nextMeta === prevMeta) {
    log('output byte-identical to committed state; nothing to write.');
    return { status: 'unchanged', meta, voiced, review: merged.review };
  }

  deps.writeText('recalls', nextRecalls);
  deps.writeText('review', nextReview);
  deps.writeText('meta', nextMeta);
  log(
    `wrote ${voiced.length} records (${voiced.filter((r) => r.confidence === 'verified').length} verified, ` +
      `${voiced.filter((r) => r.confidence === 'extracted').length} extracted, ` +
      `${voiced.filter((r) => r.headline === null).length} awaiting voice)`,
  );
  return { status: 'wrote', meta, voiced, review: merged.review };
}

// --- entry point --------------------------------------------------------------

/** Production wiring: real fetchers, real Gemini, real filesystem. */
function realDeps(): RefreshDeps {
  const recallsUrl = new URL('../data/recalls.json', import.meta.url);
  const reviewUrl = new URL('../data/review.json', import.meta.url);
  const metaUrl = new URL('../data/meta.json', import.meta.url);
  const urlFor = (name: FileName) =>
    name === 'recalls' ? recallsUrl : name === 'review' ? reviewUrl : metaUrl;

  return {
    fetchOpenFda,
    fetchFdaRss: fetchFdaRssRecalls,
    fetchFsis,
    loadCommittedRecalls: () => {
      try {
        return JSON.parse(readFileSync(recallsUrl, 'utf8')) as Recall[];
      } catch {
        return [];
      }
    },
    loadCommittedText: (name) => {
      try {
        return readFileSync(urlFor(name), 'utf8');
      } catch {
        return null;
      }
    },
    writeText: (name, text) => {
      writeFileSync(urlFor(name), text);
    },
    voice: async (recalls) => {
      const apiKey = process.env.GEMINI_API_KEY ?? '';
      if (apiKey === '') {
        console.log('GEMINI_API_KEY not set — publishing records with government reason as fallback.');
        return recalls;
      }
      const outcome = await applyVoice(recalls, {
        client: createGeminiClient(apiKey),
        fetchPageText: (recall) => fetchPressRelease(recall.sourceUrl),
        onWarn: (m) => console.warn(`  voice: ${m}`),
      });
      console.log(`voice: ${outcome.voiced} voiced, ${outcome.enriched} enriched, ${outcome.failed} fell back`);
      if (outcome.dropped.length > 0) {
        console.log(`  dropped ${outcome.dropped.length} extracted values not found in their source page`);
      }
      return outcome.recalls;
    },
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
}

// Guard so importing this module from tests does not execute the pipeline.
const isEntryPoint =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const result = await refresh(realDeps());
  if (result.status === 'refused-empty') {
    process.exit(1);
  }
}
