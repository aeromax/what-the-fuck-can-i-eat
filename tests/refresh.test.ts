import { describe, expect, it } from 'vitest';
import { RecallSchema, type Recall } from '../src/recall.ts';
import {
  CommittedRecallsSchema,
  refresh,
  stableSerialize,
  type FileName,
  type MetaFile,
  type RefreshDeps,
  type CommittedRecalls,
  type SourceOutcome,
} from '../scripts/refresh.ts';

// Offline only. No source calls, no Gemini, no filesystem — every dep is a
// stub. Refresh is the orchestrator; the fetchers and voice pipeline it wires
// together are already covered elsewhere.

function makeRecall(overrides: Partial<Recall> = {}): Recall {
  return RecallSchema.parse({
    id: 'fdaRss:example',
    product: 'Example Product',
    brand: 'Example Brand',
    company: 'Example Co',
    reason: 'Undeclared allergen',
    announcedDate: '2026-08-30',
    source: 'fdaRss',
    sourceUrl: 'https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts/example',
    confidence: 'extracted',
    ...overrides,
  });
}

const okSource = (recalls: Recall[], note = 'ok'): SourceOutcome => ({
  recalls,
  reachable: true,
  note,
});

const downSource = (note = 'HTTP 503'): SourceOutcome => ({
  recalls: [],
  reachable: false,
  note,
});

interface StubIO {
  committed: Partial<Record<FileName, string>>;
  writes: Record<FileName, string>;
  warnings: string[];
  errors: string[];
  logs: string[];
  voiceReceived: Recall[] | null;
  loadCalls: number;
}

function makeDeps(
  sources: {
    openfda?: SourceOutcome;
    rss?: SourceOutcome;
    fsis?: SourceOutcome;
    openfdaThrow?: Error;
  } = {},
  options: {
    committedRecalls?: Recall[];
    /** Overrides `committedRecalls` entirely — drives the unreadable-state path. */
    committedRecallsResult?: CommittedRecalls;
    committedRecallsText?: string;
    committedReviewText?: string;
    committedMetaText?: string;
    voice?: (recalls: Recall[]) => Recall[] | Promise<Recall[]>;
  } = {},
): { deps: RefreshDeps; io: StubIO } {
  const io: StubIO = {
    committed: {
      recalls: options.committedRecallsText,
      review: options.committedReviewText,
      meta: options.committedMetaText,
    },
    writes: {} as Record<FileName, string>,
    warnings: [],
    errors: [],
    logs: [],
    voiceReceived: null,
    loadCalls: 0,
  };

  const deps: RefreshDeps = {
    fetchOpenFda: async () => {
      if (sources.openfdaThrow) throw sources.openfdaThrow;
      return sources.openfda ?? downSource('no fixture');
    },
    fetchFdaRss: async () => sources.rss ?? downSource('no fixture'),
    fetchFsis: async () => sources.fsis ?? downSource('no fixture'),
    loadCommittedRecalls: () => {
      io.loadCalls += 1;
      return options.committedRecallsResult ?? { ok: true, recalls: options.committedRecalls ?? [] };
    },
    loadCommittedText: (name) => io.committed[name] ?? null,
    writeText: (name, text) => {
      io.writes[name] = text;
    },
    voice: async (recalls) => {
      io.voiceReceived = recalls;
      return options.voice ? await options.voice(recalls) : recalls;
    },
    log: (m) => io.logs.push(m),
    warn: (m) => io.warnings.push(m),
    error: (m) => io.errors.push(m),
  };
  return { deps, io };
}

describe('refresh: sources reachability recorded', () => {
  it('records reachable=true/false and count for each source in meta', async () => {
    const r = makeRecall();
    const { deps, io } = makeDeps({
      openfda: okSource([r]),
      rss: downSource('HTTP 500'),
      fsis: okSource([]),
    });

    const result = await refresh(deps);

    expect(result.meta.sources).toEqual([
      { name: 'openFDA', reachable: true, note: 'ok', count: 1 },
      { name: 'FDA RSS', reachable: false, note: 'HTTP 500', count: 0 },
      { name: 'FSIS', reachable: true, note: 'ok', count: 0 },
    ]);
    // Zero-record reachable source must warn loudly — silent-FSIS is the named
    // failure mode in CLAUDE.md that kills meat-and-poultry coverage without
    // notice.
    expect(io.warnings.some((w) => w.includes('FSIS') && w.includes('zero'))).toBe(true);
  });

  it('catches a thrown source so the others still publish', async () => {
    const r = makeRecall();
    const { deps, io } = makeDeps({
      openfdaThrow: new Error('boom'),
      rss: okSource([r]),
      fsis: downSource(),
    });

    const result = await refresh(deps);

    expect(result.status).toBe('wrote');
    expect(result.meta.sources[0]!.reachable).toBe(false);
    expect(result.meta.sources[0]!.note).toContain('boom');
    expect(result.voiced).toHaveLength(1);
    expect(io.writes.recalls).toBeDefined();
  });
});

describe('refresh: degrade never blank', () => {
  it('refuses to overwrite recalls.json when all sources fail', async () => {
    const { deps, io } = makeDeps({
      openfda: downSource(),
      rss: downSource(),
      fsis: downSource(),
    });

    const result = await refresh(deps);

    expect(result.status).toBe('refused-empty');
    expect(io.writes.recalls).toBeUndefined();
    expect(io.writes.review).toBeUndefined();
    expect(io.writes.meta).toBeUndefined();
    expect(io.errors.some((e) => e.includes('empty'))).toBe(true);
  });

  it('publishes when at least one source has records, even if others are down', async () => {
    const r = makeRecall();
    const { deps, io } = makeDeps({
      openfda: downSource(),
      rss: downSource(),
      fsis: okSource([r]),
    });

    const result = await refresh(deps);

    expect(result.status).toBe('wrote');
    expect(io.writes.recalls).toContain('Example Product');
  });
});

describe('refresh: byte-identical short-circuit', () => {
  it('writes nothing when serialized output matches committed files', async () => {
    const r = makeRecall({ headline: 'stable joke', avoidLine: 'stable line' });
    const committedRecalls = stableSerialize([r]);
    const committedReview = stableSerialize([]);
    const committedMeta = stableSerialize({
      sources: [
        { name: 'openFDA', reachable: true, note: 'ok', count: 1 },
        { name: 'FDA RSS', reachable: false, note: 'HTTP 500', count: 0 },
        { name: 'FSIS', reachable: false, note: 'HTTP 500', count: 0 },
      ],
    } satisfies MetaFile);

    const { deps, io } = makeDeps(
      {
        openfda: okSource([r]),
        rss: downSource('HTTP 500'),
        fsis: downSource('HTTP 500'),
      },
      {
        committedRecalls: [r],
        committedRecallsText: committedRecalls,
        committedReviewText: committedReview,
        committedMetaText: committedMeta,
      },
    );

    const result = await refresh(deps);

    expect(result.status).toBe('unchanged');
    expect(io.writes.recalls).toBeUndefined();
    expect(io.writes.review).toBeUndefined();
    expect(io.writes.meta).toBeUndefined();
  });

  it('writes when anything differs from committed', async () => {
    const r = makeRecall({ headline: 'stable joke', avoidLine: 'stable line' });
    const committedRecalls = stableSerialize([r]);

    // Meta differs (source note changes) even though recalls match.
    const { deps, io } = makeDeps(
      {
        openfda: okSource([r], 'different note'),
        rss: downSource(),
        fsis: downSource(),
      },
      {
        committedRecalls: [r],
        committedRecallsText: committedRecalls,
        committedReviewText: stableSerialize([]),
        committedMetaText: stableSerialize({ sources: [] } satisfies MetaFile),
      },
    );

    const result = await refresh(deps);

    expect(result.status).toBe('wrote');
    // Recalls text still matches, but we rewrite all three under a single
    // "output changed" signal so meta and review can never drift out of sync
    // with recalls on disk.
    expect(io.writes.meta).toBeDefined();
  });
});

describe('refresh: carryVoiceForward is invoked with committed state', () => {
  it('lets the voice step see the previously-committed headline on a fresh record', async () => {
    // Committed record has voice. The fresh fetch — as always — arrives with
    // headline: null. Without carryVoiceForward, applyVoice would regenerate.
    const committed = makeRecall({
      id: 'fdaRss:carried',
      headline: 'from a previous run',
      avoidLine: 'from a previous run',
      displayName: 'donuts',
    });
    const fresh = makeRecall({ id: 'fdaRss:carried' }); // headline is null

    const { deps, io } = makeDeps(
      {
        openfda: downSource(),
        rss: okSource([fresh]),
        fsis: downSource(),
      },
      { committedRecalls: [committed] },
    );

    await refresh(deps);

    expect(io.voiceReceived).not.toBeNull();
    expect(io.voiceReceived).toHaveLength(1);
    // This is the invariant that the step-7 bug broke: the voice step must see
    // the prior headline attached to the fresh record, or every run rewrites
    // the whole page.
    expect(io.voiceReceived![0]!.headline).toBe('from a previous run');
    expect(io.voiceReceived![0]!.displayName).toBe('donuts');
  });

  it('does not carry voice to a record whose id did not exist previously', async () => {
    const committed = makeRecall({ id: 'fdaRss:old', headline: 'old joke' });
    const fresh = makeRecall({ id: 'fdaRss:new' });

    const { deps, io } = makeDeps(
      {
        openfda: downSource(),
        rss: okSource([fresh]),
        fsis: downSource(),
      },
      { committedRecalls: [committed] },
    );

    await refresh(deps);

    expect(io.voiceReceived).toHaveLength(1);
    expect(io.voiceReceived![0]!.id).toBe('fdaRss:new');
    expect(io.voiceReceived![0]!.headline).toBeNull();
  });
});


describe('refresh: committed state must be readable', () => {
  it('aborts without fetching, writing, or voicing when recalls.json is corrupt', async () => {
    const r = makeRecall();
    const { deps, io } = makeDeps(
      { openfda: okSource([r]), rss: okSource([r]), fsis: okSource([r]) },
      { committedRecallsResult: { ok: false, reason: 'not valid JSON: Unexpected token <' } },
    );

    const result = await refresh(deps);

    expect(result.status).toBe('aborted-unreadable-state');
    // Nothing written: last-good recalls.json stays exactly as it is on disk.
    expect(io.writes.recalls).toBeUndefined();
    expect(io.writes.review).toBeUndefined();
    expect(io.writes.meta).toBeUndefined();
    // And crucially, voice never ran — an empty prior state would have made
    // carryVoiceForward treat every record as new and regenerate the page.
    expect(io.voiceReceived).toBeNull();
    expect(io.errors.some((e) => e.includes('recalls.json'))).toBe(true);
    expect(io.errors.some((e) => e.includes('regenerate'))).toBe(true);
  });

  it('treats a missing file as a quiet first run', async () => {
    const fresh = makeRecall();
    const { deps, io } = makeDeps(
      { openfda: downSource(), rss: okSource([fresh]), fsis: downSource() },
      { committedRecallsResult: { ok: true, recalls: [] } },
    );

    const result = await refresh(deps);

    expect(result.status).toBe('wrote');
    expect(io.errors).toEqual([]);
    expect(io.voiceReceived).toHaveLength(1);
  });

  it('reads the committed state exactly once, before the sources', async () => {
    const { deps, io } = makeDeps({ openfda: okSource([makeRecall()]) });
    await refresh(deps);
    expect(io.loadCalls).toBe(1);
  });
});

describe('CommittedRecallsSchema', () => {
  it('accepts an empty array and a well-formed record list', () => {
    expect(CommittedRecallsSchema.safeParse([]).success).toBe(true);
    expect(CommittedRecallsSchema.safeParse([makeRecall()]).success).toBe(true);
  });

  it('rejects a shape-drifted file at the read boundary rather than downstream', () => {
    expect(CommittedRecallsSchema.safeParse([{ id: 'fdaRss:x' }]).success).toBe(false);
    expect(CommittedRecallsSchema.safeParse({ recalls: [] }).success).toBe(false);
  });
});
