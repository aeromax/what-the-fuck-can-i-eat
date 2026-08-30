import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

// Transport layer for Gemini. No prompts, no domain logic, no knowledge of
// recalls — it turns (schema, instructions, text) into validated output or null.
//
// Everything here is defensive on purpose. docs/design.md §6: "Gemini failure is
// not fatal." A record publishes with its plain product name and the verbatim
// government reason rather than being dropped, so this module's contract is to
// never throw and never return unvalidated data.

/**
 * Verified against the installed SDK on 2026-08-30, not recalled:
 * `GoogleGenAI` is the exported class and `GoogleGenerativeAI` does not exist.
 *
 * The model is an ALIAS rather than a pinned version, deliberately. No API key
 * exists on this machine, so no id could be confirmed to resolve; the SDK's own
 * docs reference everything from `gemini-2.0-flash` to `gemini-3.7-flash`, so
 * any pin is a guess that fails closed — a dead id means every call errors and
 * no record ever gets voice.
 *
 * The cost of the alias is that the model can change under us. That is tolerable
 * here only because voice is generated once and never regenerated
 * (docs/design.md §6), so drift affects new records rather than rewriting the
 * page. Override per call if a specific version is ever needed.
 */
export const DEFAULT_MODEL = 'gemini-flash-latest';

export interface GenerateArgs<T> {
  /** Zod schema the response must satisfy. */
  schema: z.ZodType<T>;
  /** Instructions. Never contains recall data. */
  systemPrompt: string;
  /** The single government page text or record text being reasoned about. */
  userText: string;
}

export interface GeminiClient {
  /** Returns validated output, or null on any failure after one retry. Never throws. */
  generate<T>(args: GenerateArgs<T>): Promise<T | null>;
  /** Number of API calls actually made. Lets tests assert zero-call behaviour. */
  callCount(): number;
}

// --- JSON Schema sanitising ---------------------------------------------------

/**
 * The keywords `responseJsonSchema` accepts, transcribed from the SDK's own type
 * documentation for `GenerateContentConfig.responseJsonSchema` (verified in
 * node_modules on 2026-08-30). Anything outside this set is rejected by the API,
 * so it is dropped here rather than sent.
 */
const ALLOWED_KEYWORDS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

/** Keys whose values are maps of sub-schemas rather than sub-schemas themselves. */
const SCHEMA_MAP_KEYS = new Set(['properties', '$defs']);

function sanitiseNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitiseNode);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // `const` is not allowlisted, but a single-valued `enum` means the same
    // thing and is. Preserving the constraint beats dropping it silently.
    if (key === 'const') {
      out['enum'] = [value];
      continue;
    }
    if (!ALLOWED_KEYWORDS.has(key)) continue;

    if (SCHEMA_MAP_KEYS.has(key) && value !== null && typeof value === 'object') {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        mapped[name] = sanitiseNode(sub);
      }
      out[key] = mapped;
      continue;
    }

    out[key] = sanitiseNode(value);
  }
  return out;
}

/**
 * Converts a Zod schema into something Gemini will accept.
 *
 * Two traps live here, and CLAUDE.md describes both of them incorrectly for the
 * installed zod@4.5.1. Verified 2026-08-30:
 *
 * 1. The `~standard` key that `z.toJSONSchema()` adds is an own property that is
 *    **non-enumerable and non-configurable**. So `JSON.stringify` DOES strip it
 *    (CLAUDE.md says it will not), and `delete schema['~standard']` **throws a
 *    TypeError** in strict mode — which every ES module is. Following the note's
 *    advice literally would crash the pipeline. The structural round-trip below
 *    removes it safely.
 *
 * 2. `$schema` is not the only non-allowlisted keyword zod emits. Across the
 *    shapes this project uses, `z.toJSONSchema` also produces `const`, `default`,
 *    `minLength` and `maxLength` — and `.min(1)` on a string and `.default([])`
 *    on an array are both idioms already used in `src/recall.ts`. A targeted
 *    strip of `~standard` and `$schema` would therefore still send rejected
 *    keywords, so this filters against the allowlist instead.
 */
export function toGeminiSchema(schema: z.ZodType<unknown>): unknown {
  // The round-trip drops non-enumerable properties (`~standard`) without the
  // TypeError that `delete` would raise on a non-configurable key.
  const plain = JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as unknown;
  return sanitiseNode(plain);
}

// --- the client ---------------------------------------------------------------

/** The slice of the SDK this module uses, so tests can substitute a fake. */
export interface GenerateContentFn {
  (params: {
    model: string;
    contents: string;
    config: Record<string, unknown>;
  }): Promise<{ text?: string | undefined }>;
}

/**
 * Builds the real SDK call. Separated so tests can inject a fake without a key
 * and without a network — the suite must run offline.
 */
function realTransport(apiKey: string): GenerateContentFn {
  // The key is passed EXPLICITLY. The SDK README says the auto-detected variable
  // is GOOGLE_API_KEY while the maintainers' codegen guide says GEMINI_API_KEY;
  // they contradict each other, so neither is relied on. The key must also never
  // carry a PUBLIC_ prefix, which would make Astro inline it into shipped JS.
  const client = new GoogleGenAI({ apiKey });
  return (params) => client.models.generateContent(params);
}

/** Attempts per call on the primary model: one try, then one retry. §6. */
const MAX_ATTEMPTS = 2;

/**
 * Pause before the retry.
 *
 * Observed live on 2026-08-30: the primary model returned
 * `503 UNAVAILABLE — "This model is currently experiencing high demand"`. An
 * IMMEDIATE retry against a transient overload is close to useless, so the one
 * retry design §6 allows is spent after a short wait rather than instantly.
 */
const RETRY_DELAY_MS = 1500;

/**
 * Tried once if the primary model is still failing.
 *
 * Also observed live: `gemini-flash-latest` was 503 for several minutes while
 * `gemini-flash-lite-latest` served normally. Without a fallback a busy primary
 * means an entire run produces no voice at all. Voice is written once and never
 * regenerated, so a handful of records getting the lite model is a far smaller
 * cost than a run that silently generates nothing.
 */
export const FALLBACK_MODEL = 'gemini-flash-lite-latest';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGeminiClient(
  apiKey: string,
  model: string = DEFAULT_MODEL,
  transport?: GenerateContentFn,
  fallbackModel: string = FALLBACK_MODEL,
): GeminiClient {
  const send = transport ?? realTransport(apiKey);
  let calls = 0;

  async function attempt<T>(args: GenerateArgs<T>, useModel: string): Promise<T | null> {
    calls += 1;

    const response = await send({
      model: useModel,
      contents: args.userText,
      // responseMimeType and responseSchema nest under `config`, never at the
      // top level. Verified against GenerateContentParameters in the installed
      // SDK: `config` is a sibling of `model` and `contents`.
      config: {
        systemInstruction: args.systemPrompt,
        responseMimeType: 'application/json',
        // `responseJsonSchema`, not `responseSchema`: the SDK documents this as
        // the field that takes a JSON Schema, and requires responseSchema to be
        // omitted when it is set.
        responseJsonSchema: toGeminiSchema(args.schema),
      },
    });

    // There is no `response.parsed` on this SDK — only `.text`, typed
    // `string | undefined`. Verified in node_modules. JSON.parse plus Zod
    // validation is mandatory, not defensive: without it a well-formed but
    // wrong-shaped response would reach the page as fact.
    const text = response?.text;
    if (typeof text !== 'string' || text.trim() === '') return null;

    const parsed = args.schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  }

  return {
    async generate<T>(args: GenerateArgs<T>): Promise<T | null> {
      for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
        if (i > 0) await sleep(RETRY_DELAY_MS);
        try {
          const result = await attempt(args, model);
          if (result !== null) return result;
        } catch {
          // Swallowed on purpose: a thrown API error, a malformed JSON body and
          // a schema mismatch are all the same outcome to the caller — no voice
          // for this record, which publishes anyway.
        }
      }

      // Primary exhausted. One try on the fallback before giving up, because an
      // overloaded primary would otherwise mean a whole run with no voice.
      if (fallbackModel !== '' && fallbackModel !== model) {
        try {
          return await attempt(args, fallbackModel);
        } catch {
          // Same as above: no voice, record still publishes.
        }
      }
      return null;
    },

    callCount() {
      return calls;
    },
  };
}
