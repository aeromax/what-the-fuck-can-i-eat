// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Astro 7 defaults this to 'jsx', which collapses whitespace between adjacent
  // inline elements — `<span>` beside `<em>` renders as `helloworld`. The avoid
  // line is built from inline spans, so that default would silently corrupt the
  // one piece of text someone reads while holding the product.
  //
  // This is deliberate. Do not "clean it up". See docs/design.md §8.
  compressHTML: true,
});
