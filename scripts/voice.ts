import { z } from 'zod';
import { type Recall, RecallSchema } from '../src/recall.ts';
import type { GeminiClient } from './gemini.ts';
import { normalizeStateNames } from './states.ts';

// Gemini: prose extraction and snark. The only file in the pipeline where a
// model touches anything, and therefore the file where docs/design.md §2 is
// either upheld or quietly eroded.
//
// Two calls, deliberately separate:
//
//   1. EXTRACTION — given the text of ONE government press-release page, pull
//      out retailers, states, country of origin and lot codes. The model is
//      asked for SPANS THAT APPEAR IN THE TEXT, and every value it returns is
//      checked back against that text before it is kept. This is what makes the
//      `extracted` confidence tier honest rather than decorative.
//
//   2. VOICE — headline (snark), avoidLine (deadpan), displayName (a short food
//      name for the large type). No factual claims, no new facts.
//
// Both calls are constrained by a post-check rather than by trust: a prompt is
// not a security boundary, so after every call the protected government fields
// are compared against the originals and the whole response is discarded if any
// of them moved. See `protectedFieldsIntact`.

// --- model response shapes ----------------------------------------------------

export const ExtractionResponse = z.object({
  /** Named stores or sellers the page says stocked the product. */
  retailers: z.array(z.string()),
  /** US states named as distribution destinations. */
  states: z.array(z.string()),
  /** Only when the page states it explicitly. */
  countryOfOrigin: z.string().nullable(),
  /** Lot codes, best-by dates, UPCs — the strings printed on the package. */
  lotCodes: z.array(z.string()),
  /** True only if the page says the product went nationwide. */
  nationwide: z.boolean(),
});
export type ExtractionResponseT = z.infer<typeof ExtractionResponse>;

export const VoiceResponse = z.object({
  displayName: z.string().nullable(),
  headline: z.string(),
  avoidLine: z.string(),
});
export type VoiceResponseT = z.infer<typeof VoiceResponse>;

// --- prompts ------------------------------------------------------------------

/**
 * Extraction. The whole prompt is an argument for one instruction: copy, do not
 * reason. Everything else exists to close a specific way that instruction fails.
 */
export const EXTRACTION_PROMPT = `You extract facts from a single US government food-recall announcement.

You will be given the text of ONE government page. Everything you return must come from that page and nothing else.

ABSOLUTE RULES
- Copy values from the text. Do not infer, summarise, correct, expand or translate them.
- If the page does not state something, return an empty array or null. An empty answer is always correct when the page is silent. Guessing is never correct.
- Never use outside knowledge about the company, the product or the recall. If you happen to know something the page does not say, it does not exist for this task.
- Return values as strings that appear in the page text, so they can be found there by a plain text search.

FIELDS
- retailers: named stores, chains, restaurants or online sellers the page says sold or distributed the product. Copy the name as written ("Amazon.com", "Whole Foods Market"). Do NOT include the recalling company itself unless the page says it sold the product directly to the public. Do not include phrases like "retailers nationwide" — that is not a named retailer, it is the nationwide flag below.
- states: US states the page says the product was DISTRIBUTED to. Use full state names. Be careful: a press release usually opens with a dateline naming the company's own city and state, for example "Las Vegas, NV - August 24, 2026". That is where the company is, NOT where the product went. Never treat a dateline as distribution. If the page gives no distribution states, return an empty array.
- countryOfOrigin: the country the food or its ingredients came from, but ONLY if the page states it. Most pages do not. Return null when in doubt.
- lotCodes: the codes printed on the package that identify the recalled units - lot numbers, batch codes, best-by or use-by dates, UPC numbers. Copy each one exactly as printed, including its label if the label is part of the string. If the page describes where to find codes but lists none, return an empty array.
- nationwide: true ONLY if the page says the product was distributed nationwide, across the country, or in all 50 states. Otherwise false.

You are describing one recall. If the page mentions other recalls or related products from other firms, ignore them.`;

/**
 * Voice. The two halves of this prompt pull in opposite directions on purpose —
 * that tension is the product (docs/design.md §1) — so the deadpan half is
 * spelled out at length to stop the funny half leaking into it.
 */
export const VOICE_PROMPT = `You write the human-facing text for one entry on a website that lists US food recalls. The site's job is to tell someone standing in their kitchen, holding a package, whether the thing in their hand is the thing on the news.

You will be given government-supplied facts about one recall. You are NOT being asked to check, correct or add to those facts. You write three fields.

1. displayName - the short common name of the food, shown in large type.
- One to three words, lowercase. The ordinary name a shopper would use: "eggs", "ground beef", "lettuce", "pasta sauce".
- It must name the food actually described in the product text you are given. Never guess a category from the brand or the company name.
- No brand names. No pack sizes. No UPCs.
- No adjective that narrows or widens who is affected. "organic eggs" is wrong because it excludes affected people; "all eggs" is wrong because it includes unaffected ones. "eggs" is right.
- If the product is a compound or unfamiliar item, use the government's own head noun rather than inventing a tidier category.
- Return null if you cannot name the food confidently from the text given. Null is safe: the page falls back to the full government description. A WRONG NAME IS WORSE THAN NO NAME.

2. headline - the snark. This is the only place humour belongs on the entire page.
- One short line. Dry, deadpan-funny, a little exasperated. Never cruel, never mocking the people who ate the food, never joking about anyone being harmed.
- It may be wry about the absurdity of the situation. It must not overstate or understate the hazard.
- Do not state facts here that you were not given.

3. avoidLine - the factual line, read by someone holding the product.
- THIS IS NOT FUNNY. No jokes, no wordplay, no personality. A person may be deciding whether to feed this to a child.
- Say plainly what to avoid and how to recognise it: the food, the brand if given, and the identifying details given to you such as lot codes, best-by dates, stores or states.
- Use only the facts supplied. Never invent a lot code, a date, a store or a state. If a detail was not supplied, leave it out.
- Do not tell the reader what the hazard will do to them beyond what the supplied reason says, and do not add reassurance or advice that was not supplied.
- One or two plain sentences.`;

// --- protected fields ---------------------------------------------------------

/**
 * Fields a model response may never change.
 *
 * The response schemas above cannot express these, so in normal operation they
 * are unreachable. This exists anyway because a prompt is not a security
 * boundary and a schema is only as good as the next edit to it: if a future
 * change ever spreads model output over a record, this is what catches it.
 */
export const PROTECTED_FIELDS = [
  'id',
  'source',
  'brand',
  'company',
  'product',
  'reason',
  'announcedDate',
  'classification',
  'sourceUrl',
  'confidence',
] as const;

export function protectedFieldsIntact(before: Recall, after: Recall): boolean {
  return PROTECTED_FIELDS.every((field) => Object.is(before[field], after[field]));
}

// --- verifying extracted values against the source page -----------------------

/** Collapses to lowercase alphanumerics so "Lot 26078" matches "lot  26078". */
function searchable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when a returned value can actually be found in the page it came from.
 *
 * This is the mechanism behind "extraction only" (docs/design.md §2): the model
 * is asked for spans, and anything that is not a span is dropped. It cannot stop
 * the model copying the WRONG span — a dateline state is still literally present
 * on the page — so it is a floor, not a ceiling.
 */
export function appearsIn(value: string, pageText: string): boolean {
  const needle = searchable(value);
  if (needle === '') return false;
  return searchable(pageText).includes(needle);
}

const STATE_CODES: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY', 'District of Columbia': 'DC', 'Puerto Rico': 'PR',
};

const NATIONWIDE_PHRASE = /\b(nationwide|nation-wide|all 50 states|across the country|throughout the united states)\b/i;

export interface VerifiedExtraction {
  values: ExtractionResponseT;
  /** Values discarded because they were not present in the source page. */
  dropped: string[];
}

/**
 * Keeps only what the page actually says.
 *
 * Every returned string must be findable in the page text. States are matched by
 * full name or 2-letter code, since a page may write either. `nationwide` is not
 * taken on the model's word at all — the page must literally contain a
 * nationwide phrase — because an incorrect nationwide flag would tell people in
 * 49 states that a local recall affects them.
 */
export function verifyExtraction(
  response: ExtractionResponseT,
  pageText: string,
): VerifiedExtraction {
  const dropped: string[] = [];

  const keepStrings = (values: string[], label: string) =>
    values
      .map((v) => v.trim())
      .filter((v) => v !== '')
      .filter((v) => {
        if (appearsIn(v, pageText)) return true;
        dropped.push(`${label}: ${v}`);
        return false;
      });

  const retailers = keepStrings(response.retailers, 'retailer');
  const lotCodes = keepStrings(response.lotCodes, 'lotCode');

  // Canonicalise first so "california" and "CA" both become "California", then
  // require the page to contain either the name or the code.
  const { states: canonical } = normalizeStateNames(response.states);
  const states = canonical.filter((name) => {
    const code = STATE_CODES[name];
    const byName = appearsIn(name, pageText);
    const byCode = code !== undefined && new RegExp(`\\b${code}\\b`).test(pageText);
    if (byName || byCode) return true;
    dropped.push(`state: ${name}`);
    return false;
  });

  let countryOfOrigin: string | null = null;
  if (response.countryOfOrigin !== null) {
    const value = response.countryOfOrigin.trim();
    if (value !== '' && appearsIn(value, pageText)) countryOfOrigin = value;
    else if (value !== '') dropped.push(`countryOfOrigin: ${value}`);
  }

  const nationwide = response.nationwide && NATIONWIDE_PHRASE.test(pageText);
  if (response.nationwide && !nationwide) dropped.push('nationwide: not stated on page');

  return {
    values: { retailers, states, countryOfOrigin, lotCodes, nationwide },
    dropped,
  };
}

// --- prompt inputs ------------------------------------------------------------

/**
 * The government facts handed to the voice call.
 *
 * Assembled explicitly rather than by serialising the record, so that adding a
 * field to `Recall` can never silently widen what the model is shown.
 */
export function voiceInput(recall: Recall): string {
  const lines = [
    `Product (government description): ${recall.product}`,
    recall.brand !== '' ? `Brand: ${recall.brand}` : null,
    recall.company !== '' ? `Recalling company: ${recall.company}` : null,
    `Reason for recall (verbatim): ${recall.reason}`,
    recall.lotCodes.length > 0 ? `Lot codes / dates: ${recall.lotCodes.join(' | ')}` : null,
    recall.retailers.length > 0 ? `Sold at: ${recall.retailers.join(', ')}` : null,
    recall.nationwide
      ? 'Distribution: nationwide'
      : recall.states.length > 0
        ? `Distribution: ${recall.states.join(', ')}`
        : null,
    recall.countryOfOrigin !== null ? `Country of origin: ${recall.countryOfOrigin}` : null,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// --- orchestration ------------------------------------------------------------

export interface VoiceDeps {
  client: GeminiClient;
  /**
   * Returns the government page text for a record, or null.
   *
   * Injected rather than imported so tests stay offline, and so the fetch policy
   * lives with the caller. Extraction is skipped entirely when absent.
   */
  fetchPageText?: (recall: Recall) => Promise<string | null>;
  onWarn?: (message: string) => void;
  /**
   * Attempts per call. Defaults to 1 — meaning no retry HERE, deliberately.
   *
   * `createGeminiClient` already retries once internally before returning null
   * (verified against scripts/gemini.ts, 2026-08-30), which is exactly the one
   * retry build plan step 7 asks for. Raising this would multiply with that and
   * quietly quadruple the call count on a failing run.
   */
  maxAttempts?: number;
}

export interface VoiceOutcome {
  recalls: Recall[];
  /** Records that gained a headline this run. */
  voiced: number;
  /** Records whose prose fields were filled from their source page. */
  enriched: number;
  /** Records left with their fallback rendering after a failure. */
  failed: number;
  /** Extraction values discarded for not appearing in the source page. */
  dropped: string[];
}

/**
 * Extraction is for FDA press releases and nothing else.
 *
 * openFDA records get these fields from structured columns, and docs/design.md
 * §2 forbids a model touching FSIS data at all — "anything from FSIS: never".
 * Encoding that as a function keeps it from being loosened by accident.
 */
export function isExtractionCandidate(recall: Recall): boolean {
  return recall.source === 'fdaRss' && recall.confidence === 'extracted';
}

async function callWithRetry<T>(
  attempts: number,
  run: () => Promise<T | null>,
): Promise<T | null> {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const result = await run();
    if (result !== null) return result;
  }
  return null;
}

/**
 * Adds voice to records that lack it. Never throws, never drops a record.
 *
 * "Never regenerate existing voice" (docs/design.md §6) is the reason this is
 * cheap: a record with a headline is skipped before any call is made, so a
 * typical run — where nothing new was announced — costs nothing at all.
 */
export async function applyVoice(recalls: Recall[], deps: VoiceDeps): Promise<VoiceOutcome> {
  const { client, fetchPageText, onWarn = () => {}, maxAttempts = 1 } = deps;

  const out: Recall[] = [];
  const dropped: string[] = [];
  let voiced = 0;
  let enriched = 0;
  let failed = 0;

  for (const original of recalls) {
    // Skip before spending anything. This is the cost control and the reason
    // the page's voice stays stable between runs.
    if (original.headline !== null) {
      out.push(original);
      continue;
    }

    let working = original;

    try {
      if (isExtractionCandidate(original) && fetchPageText) {
        const pageText = await fetchPageText(original);
        if (pageText !== null && pageText.trim() !== '') {
          const response = await callWithRetry(maxAttempts, () =>
            client.generate({
              schema: ExtractionResponse,
              systemPrompt: EXTRACTION_PROMPT,
              userText: pageText,
            }),
          );

          if (response === null) {
            onWarn(`extraction failed for ${original.id}`);
          } else {
            const verified = verifyExtraction(response, pageText);
            dropped.push(...verified.dropped.map((d) => `${original.id} — ${d}`));
            working = {
              ...working,
              retailers: verified.values.retailers,
              states: verified.values.states,
              countryOfOrigin: verified.values.countryOfOrigin,
              lotCodes: verified.values.lotCodes,
              nationwide: working.nationwide || verified.values.nationwide,
            };
            enriched += 1;
          }
        } else {
          onWarn(`no page text for ${original.id}`);
        }
      }

      const voice = await callWithRetry(maxAttempts, () =>
        client.generate({
          schema: VoiceResponse,
          systemPrompt: VOICE_PROMPT,
          userText: voiceInput(working),
        }),
      );

      if (voice === null) {
        // Not fatal. The record publishes with its plain product name and the
        // verbatim government reason — docs/design.md §6. Any extraction that
        // did succeed is kept; it is government text either way.
        onWarn(`voice failed for ${original.id}`);
        failed += 1;
        out.push(finalise(original, working, onWarn));
        continue;
      }

      const candidate: Recall = {
        ...working,
        displayName: emptyToNull(voice.displayName),
        headline: emptyToNull(voice.headline),
        avoidLine: emptyToNull(voice.avoidLine),
      };

      const settled = finalise(original, candidate, onWarn);
      if (settled.headline !== null) voiced += 1;
      else failed += 1;
      out.push(settled);
    } catch (error) {
      // An item is never dropped for lack of a joke.
      onWarn(`voice threw for ${original.id}: ${(error as Error).message}`);
      failed += 1;
      out.push(original);
    }
  }

  return { recalls: out, voiced, enriched, failed, dropped };
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Last gate before a record is published.
 *
 * Rejects the whole candidate — not just the offending field — if a protected
 * government fact moved or the record no longer validates. Falling back to the
 * original costs a joke; publishing a tampered record costs the thing the page
 * exists for.
 */
function finalise(original: Recall, candidate: Recall, onWarn: (m: string) => void): Recall {
  if (!protectedFieldsIntact(original, candidate)) {
    onWarn(`discarded response for ${original.id}: protected field changed`);
    return original;
  }

  const parsed = RecallSchema.safeParse(candidate);
  if (!parsed.success) {
    onWarn(`discarded response for ${original.id}: ${parsed.error.message}`);
    return original;
  }

  return parsed.data;
}


/**
 * Carries existing voice forward onto freshly fetched records.
 *
 * Without this, "never regenerate existing voice" (docs/design.md §6) cannot
 * hold: every run re-fetches from the sources and produces records with
 * `headline: null`, so `applyVoice` would regard the entire page as ungenerated
 * and rewrite it — multiplying cost on every run and changing the voice under
 * the reader for no reason.
 *
 * Caught on the first live run, where the voiced count went DOWN between runs
 * (50 to 47) as transient API failures reshuffled which records happened to
 * succeed that time.
 *
 * Only voice fields cross over. Facts always come from the fresh fetch, so a
 * correction upstream still reaches the page.
 */
export function carryVoiceForward(previous: readonly Recall[], current: readonly Recall[]): Recall[] {
  const byId = new Map(previous.map((r) => [r.id, r]));

  return current.map((recall) => {
    const old = byId.get(recall.id);
    if (old === undefined) return recall;

    return {
      ...recall,
      displayName: recall.displayName ?? old.displayName,
      headline: recall.headline ?? old.headline,
      avoidLine: recall.avoidLine ?? old.avoidLine,
      // Extraction is a paid model call too, so its results are kept unless the
      // fresh record already has better (structured) values.
      retailers: recall.retailers.length > 0 ? recall.retailers : old.retailers,
      countryOfOrigin: recall.countryOfOrigin ?? old.countryOfOrigin,
    };
  });
}
