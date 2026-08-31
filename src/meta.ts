import { z } from 'zod';

// Shape and runtime schema for `data/meta.json`. Lives in src/ rather than in
// scripts/refresh.ts because the page imports it — pulling refresh.ts into an
// Astro page would drag in impit and the source fetchers via its transitive
// imports, which have no business on the render path.

export const SourceReportSchema = z.object({
  name: z.enum(['openFDA', 'FDA RSS', 'FSIS']),
  reachable: z.boolean(),
  note: z.string(),
  count: z.number().int().nonnegative(),
});

export const MetaSchema = z.object({
  /** Order is display order; the page renders them top-to-bottom in the footer. */
  sources: z.array(SourceReportSchema),
});

export type SourceReport = z.infer<typeof SourceReportSchema>;
export type MetaFile = z.infer<typeof MetaSchema>;
