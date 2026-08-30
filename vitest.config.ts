import { getViteConfig } from 'astro/config';

// getViteConfig, not defineConfig: rendering .astro components in a test needs
// Astro's own Vite plugin to compile them. Without it vitest hands the raw
// component to esbuild and fails with "invalid JS syntax" on the first
// expression in the template.
export default getViteConfig({
  test: {
    // Required for tests that render Astro components. See docs/design.md §8.
    environment: 'node',

    include: ['tests/**/*.test.ts'],
  },
});
