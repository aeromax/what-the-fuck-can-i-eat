import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_MODEL,
  type GenerateContentFn,
  createGeminiClient,
  toGeminiSchema,
} from '../scripts/gemini.ts';

// Everything here runs offline. There is no API key on this machine and none is
// needed: the SDK call is injected, so these tests exercise the wrapper's
// contract rather than Gemini's behaviour.

const Answer = z.object({ headline: z.string(), tags: z.array(z.string()) });

/** A fake transport returning canned `.text` values, one per attempt. */
function fakeTransport(responses: Array<{ text?: string } | Error>): {
  fn: GenerateContentFn;
  params: Array<{ model: string; contents: string; config: Record<string, unknown> }>;
} {
  const params: Array<{ model: string; contents: string; config: Record<string, unknown> }> = [];
  let i = 0;
  const fn: GenerateContentFn = async (p) => {
    params.push(p);
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next ?? {};
  };
  return { fn, params };
}

const args = {
  schema: Answer,
  systemPrompt: 'instructions',
  userText: 'government page text',
};

describe('generate', () => {
  it('returns validated output on a good response', async () => {
    const { fn } = fakeTransport([{ text: '{"headline":"eggs","tags":["a"]}' }]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    expect(await client.generate(args)).toEqual({ headline: 'eggs', tags: ['a'] });
    expect(client.callCount()).toBe(1);
  });

  it('retries exactly once on malformed JSON, then gives up', async () => {
    const { fn } = fakeTransport([{ text: 'not json at all' }]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    expect(await client.generate(args)).toBeNull();
    // One try plus exactly one retry. docs/design.md §6.
    expect(client.callCount()).toBe(2);
  });

  it('rejects well-formed JSON that does not match the schema', async () => {
    // This is the case `response.parsed` would have hidden: valid JSON, wrong
    // shape. Without Zod validation it would reach the page as fact.
    const { fn } = fakeTransport([{ text: '{"headline":42,"tags":"not-an-array"}' }]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    expect(await client.generate(args)).toBeNull();
  });

  it('returns null when .text is undefined rather than crashing', async () => {
    // `.text` is typed `string | undefined` on this SDK.
    const { fn } = fakeTransport([{}]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    expect(await client.generate(args)).toBeNull();
  });

  it('returns null when .text is empty', async () => {
    const { fn } = fakeTransport([{ text: '   ' }]);
    expect(await createGeminiClient('k', DEFAULT_MODEL, fn).generate(args)).toBeNull();
  });

  it('never throws when the API throws', async () => {
    const { fn } = fakeTransport([new Error('503 Service Unavailable')]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    await expect(client.generate(args)).resolves.toBeNull();
    expect(client.callCount()).toBe(2);
  });

  it('succeeds on the retry when the first attempt fails', async () => {
    const { fn } = fakeTransport([
      new Error('transient'),
      { text: '{"headline":"lettuce","tags":[]}' },
    ]);
    const client = createGeminiClient('k', DEFAULT_MODEL, fn);

    expect(await client.generate(args)).toEqual({ headline: 'lettuce', tags: [] });
    expect(client.callCount()).toBe(2);
  });

  it('makes zero calls until asked', () => {
    // Lets a caller prove it skipped records that already have voice.
    const { fn } = fakeTransport([{ text: '{}' }]);
    expect(createGeminiClient('k', DEFAULT_MODEL, fn).callCount()).toBe(0);
  });
});

describe('request shape', () => {
  it('nests generation settings under config, never at the top level', async () => {
    const { fn, params } = fakeTransport([{ text: '{"headline":"x","tags":[]}' }]);
    await createGeminiClient('k', DEFAULT_MODEL, fn).generate(args);

    const sent = params[0]!;
    expect(sent.config.responseMimeType).toBe('application/json');
    expect(sent.config.responseJsonSchema).toBeDefined();
    expect(sent).not.toHaveProperty('responseMimeType');
    expect(sent).not.toHaveProperty('responseSchema');
  });

  it('sends the prompt as instructions and the page text as content', async () => {
    const { fn, params } = fakeTransport([{ text: '{"headline":"x","tags":[]}' }]);
    await createGeminiClient('k', DEFAULT_MODEL, fn).generate(args);

    expect(params[0]!.config.systemInstruction).toBe('instructions');
    expect(params[0]!.contents).toBe('government page text');
  });

  it('uses the requested model', async () => {
    const { fn, params } = fakeTransport([{ text: '{"headline":"x","tags":[]}' }]);
    await createGeminiClient('k', 'some-other-model', fn).generate(args);
    expect(params[0]!.model).toBe('some-other-model');
  });
});

describe('schema sanitising', () => {
  // Deliberately nested, with arrays and objects at depth, so the checks below
  // are real rather than trivially satisfied by a flat schema.
  const Nested = z.object({
    name: z.string().min(1).max(80),
    lots: z.array(z.string()).default([]),
    kind: z.literal('recall'),
    inner: z.object({
      deep: z.array(z.object({ code: z.string().nullable(), n: z.number().min(0) })),
    }),
  });

  const keysAtEveryDepth = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) {
      node.forEach((n) => keysAtEveryDepth(n, out));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        out.push(k);
        keysAtEveryDepth(v, out);
      }
    }
    return out;
  };

  it('emits no ~standard key at any depth', () => {
    // zod adds `~standard` as a non-enumerable, NON-CONFIGURABLE own property.
    // `delete` on it throws a TypeError in strict mode, so it is removed by a
    // structural round-trip instead.
    const keys = keysAtEveryDepth(toGeminiSchema(Nested));
    expect(keys).not.toContain('~standard');
  });

  it('drops every keyword outside Gemini’s allowlist', () => {
    // Raw zod output for this shape contains $schema, default, minLength,
    // maxLength and const — all rejected by the API.
    const keys = new Set(keysAtEveryDepth(toGeminiSchema(Nested)));
    for (const banned of ['$schema', 'default', 'minLength', 'maxLength', 'const', 'exclusiveMinimum']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('keeps the structure the model needs', () => {
    const schema = toGeminiSchema(Nested) as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema.type).toBe('object');
    expect(Object.keys(properties).sort()).toEqual(['inner', 'kind', 'lots', 'name']);
    expect(properties.lots!.type).toBe('array');
    // Nested sub-schemas survive sanitising rather than being flattened away.
    const inner = properties.inner!.properties as Record<string, Record<string, unknown>>;
    expect((inner.deep!.items as Record<string, unknown>).type).toBe('object');
  });

  it('preserves a literal as a single-valued enum', () => {
    // `const` is not allowlisted but `enum` is, and they mean the same thing
    // here — so the constraint survives instead of being silently dropped.
    const schema = toGeminiSchema(Nested) as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind!.enum).toEqual(['recall']);
  });

  it('produces something JSON-serialisable end to end', () => {
    expect(() => JSON.stringify(toGeminiSchema(Nested))).not.toThrow();
  });
});
