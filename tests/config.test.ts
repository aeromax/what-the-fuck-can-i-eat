import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// These guard traps recorded in docs/design.md §8. Each one has already cost a
// debugging session once, and each fails silently rather than loudly — which is
// exactly the kind of regression a test should catch instead of a person.
describe('project configuration', () => {
  it('sets compressHTML explicitly', () => {
    // Astro 7 defaults to 'jsx', which eats whitespace between adjacent inline
    // elements. The avoid line is inline spans; that default would corrupt it.
    expect(read('astro.config.mjs')).toMatch(/compressHTML:\s*true/);
  });

  it('pins every dependency exactly', () => {
    // docs/design.md §8 records live-verified versions, several of which
    // contradict what a resolver would otherwise pick: typescript must stay on
    // 6.x for @astrojs/check, and @google/genai must stay below 3.0.0. A caret
    // would let either drift on the next clean install.
    const pkg = JSON.parse(read('package.json'));
    const pinned = { ...pkg.dependencies, ...pkg.devDependencies };
    const drifting = Object.entries(pinned)
      .filter(([name]) => name !== '@types/node')
      .filter(([, range]) => !/^\d+\.\d+\.\d+$/.test(range as string));

    expect(drifting).toEqual([]);
  });

  it('does not ignore data/', () => {
    // recalls.json, review.json and the snapshots are committed on purpose —
    // git history is the audit trail for whether a wrong page came from the
    // government or from the model. See docs/design.md §5.
    expect(read('.gitignore')).not.toMatch(/^\s*data\//m);
  });

  it('never exposes the Gemini key to the client bundle', () => {
    // A PUBLIC_ prefix would make Astro inline the key into shipped JS.
    expect(read('.env.example')).not.toMatch(/PUBLIC_[A-Z_]*(API|GEMINI)/);
  });
});
