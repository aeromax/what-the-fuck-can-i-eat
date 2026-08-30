import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_PROMPT,
  ExtractionResponse,
  VOICE_PROMPT,
  appearsIn,
  applyVoice,
  isExtractionCandidate,
  protectedFieldsIntact,
  verifyExtraction,
  voiceInput,
} from '../scripts/voice.ts';
import type { GeminiClient } from '../scripts/gemini.ts';
import { RecallSchema, type Recall } from '../src/recall.ts';

// Offline only. There is no API key on this machine and these tests must never
// need one — they drive a stub client with real captured government text.

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

/** The Donutful press release as the extraction call would receive it. */
const donutfulPage = fixture('press-release-donutful.html')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#0?39;|&rsquo;/g, "'")
  .replace(/\s+/g, ' ');

const base: Recall = RecallSchema.parse({
  id: 'fdaRss:better-bakehouse-donutful',
  product: 'Chocolate Dipped Vanilla Cake Donuts',
  brand: 'Donutful',
  company: 'The Better Bakehouse Snack Company',
  reason: 'Undeclared milk allergen',
  announcedDate: '2026-08-24',
  classification: null,
  source: 'fdaRss',
  sourceUrl: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/donutful',
  confidence: 'extracted',
});

interface StubOptions {
  extraction?: unknown | null;
  voice?: unknown | null;
  throwOn?: 'extraction' | 'voice';
}

/** A GeminiClient we control, so every branch is reachable without a network. */
function stubClient(options: StubOptions): GeminiClient {
  let calls = 0;
  return {
    async generate({ schema, systemPrompt }) {
      calls += 1;
      const isExtraction = systemPrompt === EXTRACTION_PROMPT;
      if (options.throwOn === (isExtraction ? 'extraction' : 'voice')) {
        throw new Error('simulated transport failure');
      }
      const payload = isExtraction ? options.extraction : options.voice;
      if (payload === null || payload === undefined) return null;
      const parsed = schema.safeParse(payload);
      // A real client validates before returning; null means unusable.
      return parsed.success ? parsed.data : null;
    },
    callCount() {
      return calls;
    },
  };
}

const goodVoice = {
  displayName: 'donuts',
  headline: 'The donuts contain milk they forgot to mention.',
  avoidLine:
    'Do not eat Donutful Chocolate Dipped Vanilla Cake Donuts with lot 26078. They contain undeclared milk.',
};

const goodExtraction = {
  retailers: ['Amazon.com'],
  states: [],
  countryOfOrigin: null,
  lotCodes: ['Lot 26078', 'UPC: 3 50041 39210 3'],
  nationwide: true,
};

describe('never regenerate existing voice', () => {
  it('makes zero API calls for an already-voiced batch', async () => {
    const client = stubClient({ voice: goodVoice });
    const voiced = { ...base, headline: 'already written', avoidLine: 'already written' };

    const result = await applyVoice([voiced, voiced, voiced], { client });

    // The cost control for the whole project: most runs find no news and must
    // therefore spend nothing. docs/design.md §6.
    expect(client.callCount()).toBe(0);
    expect(result.voiced).toBe(0);
    expect(result.recalls).toHaveLength(3);
  });

  it('leaves existing voice byte-identical', async () => {
    const client = stubClient({ voice: goodVoice });
    const voiced = { ...base, headline: 'the original joke', avoidLine: 'the original line' };

    const [out] = (await applyVoice([voiced], { client })).recalls;

    expect(out!.headline).toBe('the original joke');
    expect(out!.avoidLine).toBe('the original line');
  });

  it('generates only for the records missing a headline', async () => {
    const client = stubClient({ voice: goodVoice });
    const done = { ...base, id: 'fdaRss:done', headline: 'has one' };

    const result = await applyVoice([done, base], { client });

    expect(client.callCount()).toBe(1);
    expect(result.voiced).toBe(1);
  });
});

describe('failure is never fatal', () => {
  it('publishes the record unchanged when the voice call fails', async () => {
    const client = stubClient({ voice: null });

    const result = await applyVoice([base], { client });

    // An item is never dropped for lack of a joke — it falls back to the plain
    // product name and the verbatim government reason.
    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0]!.headline).toBeNull();
    expect(result.recalls[0]!.product).toBe(base.product);
    expect(result.recalls[0]!.reason).toBe(base.reason);
    expect(result.failed).toBe(1);
  });

  it('does not throw when the transport throws', async () => {
    const client = stubClient({ voice: goodVoice, throwOn: 'voice' });

    const result = await applyVoice([base], { client });

    expect(result.recalls).toHaveLength(1);
    expect(result.recalls[0]!.headline).toBeNull();
  });

  it('still writes voice when only extraction fails', async () => {
    const client = stubClient({ extraction: null, voice: goodVoice });

    const result = await applyVoice([base], {
      client,
      fetchPageText: async () => donutfulPage,
    });

    expect(result.recalls[0]!.headline).toBe(goodVoice.headline);
    expect(result.enriched).toBe(0);
  });

  it('never loses a record, whatever happens', async () => {
    const client = stubClient({ voice: null, throwOn: 'voice' });
    const many = [base, { ...base, id: 'fdaRss:two' }, { ...base, id: 'fdaRss:three' }];

    const result = await applyVoice(many, { client });

    expect(result.recalls.map((r) => r.id)).toEqual(many.map((r) => r.id));
  });
});

describe('protected government fields', () => {
  it('ignores protected fields a response tries to smuggle in', async () => {
    // Two independent defences, and this exercises the FIRST one: the response
    // schema has no such fields, so Zod strips them before they reach a record.
    // The post-check below is the second, and is deliberately unreachable while
    // the schemas stay narrow — it exists for the edit that widens them.
    const client: GeminiClient = {
      async generate({ systemPrompt }) {
        if (systemPrompt === VOICE_PROMPT) {
          return {
            ...goodVoice,
            product: 'SOMETHING ELSE ENTIRELY',
            reason: 'a different hazard',
          } as never;
        }
        return null;
      },
      callCount: () => 0,
    };

    const warnings: string[] = [];
    const result = await applyVoice([base], { client, onWarn: (m) => warnings.push(m) });

    expect(result.recalls[0]!.product).toBe(base.product);
    expect(result.recalls[0]!.reason).toBe(base.reason);
  });

  it('detects every protected field individually', () => {
    // The post-check proper. Unreachable through applyVoice today, which is why
    // it is tested directly rather than end-to-end: a guard nothing exercises is
    // a guard that rots.

    const cases: Array<Partial<Recall>> = [
      { brand: 'other' },
      { company: 'other' },
      { product: 'other' },
      { reason: 'other' },
      { announcedDate: '2020-01-01' },
      { classification: 'Class I' },
      { sourceUrl: 'https://example.gov/other' },
      { confidence: 'verified' },
      { id: 'other:id' },
      { source: 'openfda' },
    ];

    for (const change of cases) {
      expect(protectedFieldsIntact(base, { ...base, ...change })).toBe(false);
    }
  });

  it('allows the voice fields to change', () => {
    const voicedRecord = { ...base, headline: 'h', avoidLine: 'a', displayName: 'donuts' };
    expect(protectedFieldsIntact(base, voicedRecord)).toBe(true);
  });
});

describe('extraction is verified against the source page', () => {
  it('keeps lot codes that appear in the page', () => {
    const { values } = verifyExtraction(ExtractionResponse.parse(goodExtraction), donutfulPage);
    expect(values.lotCodes).toContain('Lot 26078');
  });

  it('drops a lot code the page does not contain', () => {
    // The failure this whole mechanism exists to prevent: a plausible-looking
    // code that no government page ever printed.
    const { values, dropped } = verifyExtraction(
      ExtractionResponse.parse({ ...goodExtraction, lotCodes: ['Lot 26078', 'Lot 99999'] }),
      donutfulPage,
    );

    expect(values.lotCodes).toContain('Lot 26078');
    expect(values.lotCodes).not.toContain('Lot 99999');
    expect(dropped.some((d) => d.includes('99999'))).toBe(true);
  });

  it('drops a retailer the page does not name', () => {
    const { values } = verifyExtraction(
      ExtractionResponse.parse({ ...goodExtraction, retailers: ['Amazon.com', 'Costco'] }),
      donutfulPage,
    );
    expect(values.retailers).toEqual(['Amazon.com']);
  });

  it('drops a state the page does not mention', () => {
    const { values } = verifyExtraction(
      ExtractionResponse.parse({ ...goodExtraction, states: ['Florida'] }),
      donutfulPage,
    );
    expect(values.states).not.toContain('Florida');
  });

  it('drops a country of origin the page does not state', () => {
    const { values } = verifyExtraction(
      ExtractionResponse.parse({ ...goodExtraction, countryOfOrigin: 'Mexico' }),
      donutfulPage,
    );
    expect(values.countryOfOrigin).toBeNull();
  });

  it('requires the page to say nationwide, not the model', () => {
    // A wrong nationwide flag tells people in 49 states that a local recall
    // affects them, so the model's word alone is not enough.
    const stated = verifyExtraction(ExtractionResponse.parse(goodExtraction), donutfulPage);
    expect(stated.values.nationwide).toBe(true);

    const unstated = verifyExtraction(
      ExtractionResponse.parse(goodExtraction),
      'This product was distributed only in Ohio.',
    );
    expect(unstated.values.nationwide).toBe(false);
  });

  it('matches values ignoring case and spacing', () => {
    expect(appearsIn('lot   26078', donutfulPage)).toBe(true);
    expect(appearsIn('LOT 26078', donutfulPage)).toBe(true);
    expect(appearsIn('', donutfulPage)).toBe(false);
  });

  it('applies verification through the full pass', async () => {
    const client = stubClient({
      extraction: { ...goodExtraction, lotCodes: ['Lot 26078', 'Lot 00000'] },
      voice: goodVoice,
    });

    const result = await applyVoice([base], { client, fetchPageText: async () => donutfulPage });

    expect(result.recalls[0]!.lotCodes).toEqual(['Lot 26078']);
    expect(result.dropped.some((d) => d.includes('00000'))).toBe(true);
  });
});

describe('what may be extracted at all', () => {
  it('extracts only from FDA press releases', () => {
    expect(isExtractionCandidate(base)).toBe(true);
  });

  it('never sends an FSIS record for extraction', () => {
    // docs/design.md §2: "anything from FSIS — never".
    const fsis = { ...base, id: 'fsis:1', source: 'fsis' as const, confidence: 'verified' as const };
    expect(isExtractionCandidate(fsis)).toBe(false);
  });

  it('never sends an openFDA record for extraction', () => {
    // Its prose fields come from structured columns.
    const openfda = {
      ...base,
      id: 'openfda:1',
      source: 'openfda' as const,
      confidence: 'verified' as const,
    };
    expect(isExtractionCandidate(openfda)).toBe(false);
  });

  it('makes only the voice call for a verified record', async () => {
    const client = stubClient({ extraction: goodExtraction, voice: goodVoice });
    const fsis = { ...base, id: 'fsis:1', source: 'fsis' as const, confidence: 'verified' as const };

    let pageFetches = 0;
    await applyVoice([fsis], {
      client,
      fetchPageText: async () => {
        pageFetches += 1;
        return donutfulPage;
      },
    });

    expect(pageFetches).toBe(0);
    expect(client.callCount()).toBe(1);
  });
});

describe('what the model is shown', () => {
  it('sends only government facts', () => {
    const input = voiceInput({ ...base, lotCodes: ['Lot 26078'], states: ['Ohio'] });

    expect(input).toContain('Chocolate Dipped Vanilla Cake Donuts');
    expect(input).toContain('Undeclared milk allergen');
    expect(input).toContain('Lot 26078');
    // Not shown: internal plumbing the model has no business seeing.
    expect(input).not.toContain(base.id);
    expect(input).not.toContain(base.sourceUrl);
    expect(input).not.toContain('extracted');
  });

  it('omits fields that are absent rather than sending empty labels', () => {
    const input = voiceInput({ ...base, brand: '', company: '' });
    expect(input).not.toContain('Brand:');
    expect(input).not.toContain('Recalling company:');
  });
});

describe('voice output handling', () => {
  it('writes all three voice fields', async () => {
    const client = stubClient({ voice: goodVoice });
    const [out] = (await applyVoice([base], { client })).recalls;

    expect(out!.displayName).toBe('donuts');
    expect(out!.headline).toBe(goodVoice.headline);
    expect(out!.avoidLine).toBe(goodVoice.avoidLine);
  });

  it('accepts a null displayName as a safe outcome', async () => {
    // "A wrong name is worse than no name" — the page falls back to `product`.
    const client = stubClient({ voice: { ...goodVoice, displayName: null } });
    const [out] = (await applyVoice([base], { client })).recalls;

    expect(out!.displayName).toBeNull();
    expect(out!.headline).toBe(goodVoice.headline);
  });

  it('treats a blank string as null', async () => {
    const client = stubClient({ voice: { ...goodVoice, displayName: '   ' } });
    const [out] = (await applyVoice([base], { client })).recalls;
    expect(out!.displayName).toBeNull();
  });

  it('produces schema-valid records', async () => {
    const client = stubClient({ voice: goodVoice });
    const result = await applyVoice([base], { client });
    expect(RecallSchema.safeParse(result.recalls[0]).success).toBe(true);
  });
});
