import { z } from 'zod';
import { WikiPointerSchema, type WikiPointer } from './wiki';

// contracts previously had no citation schema. RAG Hit/Candidate use documentId,
// ordinal/text and optionally chunkId; persisted source data adds kbId,
// sourceVersionId and start/end. Bare hits cannot provide a trustworthy pointer.
const legacyCitationSchema = z.object({
  documentId: z.string().min(1),
  chunkId: z.string().min(1).optional(),
  vaultId: z.string().min(1).optional(),
  kbId: z.string().min(1).optional(),
  sourceVersion: z.string().min(1).optional(),
  sourceVersionId: z.string().min(1).optional(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string().max(500).optional(),
});

/** Return null when the legacy object lacks enough provenance for a WikiPointer. */
export function upgradeLegacyRagCitation(c: unknown): WikiPointer | null {
  try {
    const parsed = legacyCitationSchema.safeParse(c);
    if (!parsed.success) return null;
    const value = parsed.data;
    const result = WikiPointerSchema.safeParse({
      vaultId: value.vaultId ?? value.kbId,
      revision: 'rev-000',
      pageId: null,
      assertionId: null,
      sourceId: `src_${value.documentId}`,
      sourceVersion: value.sourceVersion ?? value.sourceVersionId,
      locator: { kind: 'offset', start: value.start, end: value.end },
      origin: 'sourced',
      ...(value.quote === undefined ? {} : { quote: value.quote }),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
