import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Required for tests that render Astro components. See docs/design.md §8.
    environment: 'node',

    include: ['tests/**/*.test.ts'],
  },
});
