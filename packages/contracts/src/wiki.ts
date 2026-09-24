import { z } from 'zod';

const revisionSchema = z.string().regex(/^rev-\d{3}$/, 'expected rev-NNN');
const sourceIdSchema = z.string().regex(/^src_.+$/u, 'expected src_ prefix and identifier');
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/, 'expected 64 hexadecimal characters');
const timestampSchema = z.iso.datetime({ offset: true });

export const SourceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
  z.object({ kind: z.literal('section'), section: z.string().min(1) }),
  z.object({ kind: z.literal('offset'), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
    .refine((v) => v.end >= v.start, { path: ['end'], message: 'end must be >= start' }),
  z.object({ kind: z.literal('time'), startSec: z.number().nonnegative(), endSec: z.number().nonnegative() })
    .refine((v) => v.endSec >= v.startSec, { path: ['endSec'], message: 'endSec must be >= startSec' }),
]);
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const WikiPointerSchema = z.object({
  vaultId: z.string().min(1),
  revision: revisionSchema,
  pageId: z.string().nullable(),
  assertionId: z.string().regex(/^asr_.+$/u, 'expected asr_ prefix and identifier').nullable(),
  sourceId: sourceIdSchema,
  sourceVersion: z.string().min(1),
  locator: SourceLocatorSchema,
  origin: z.enum(['sourced', 'inferred']),
  quote: z.string().max(500).optional(),
});
export type WikiPointer = z.infer<typeof WikiPointerSchema>;

export const SourceMetaSchema = z.object({
  sourceId: sourceIdSchema,
  familyId: z.string().min(1),
  title: z.string().min(1),
  mimeType: z.string().min(1),
  sha256: sha256Schema,
  addedBy: z.literal('user'),
  createdAt: timestampSchema,
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const DerivedPageMetaSchema = z.object({
  pageId: z.string().min(1),
  questionHash: z.string().min(1),
  origin: z.literal('derived'),
  createdAt: timestampSchema,
  revision: revisionSchema,
});
export type DerivedPageMeta = z.infer<typeof DerivedPageMetaSchema>;

export const WikiRevisionSchema = z.object({
  revision: revisionSchema,
  ontologyVersion: z.string().min(1),
  rulesVersion: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: sha256Schema })),
  releasedAt: timestampSchema,
});
export type WikiRevision = z.infer<typeof WikiRevisionSchema>;

/** Null IDs are omitted; empty string IDs and quotes remain distinct from absence. */
export function encodeWikiPointer(p: WikiPointer): string {
  const value = WikiPointerSchema.parse(p);
  const fields: Record<string, string> = {
    ...(value.pageId === null ? {} : { pageId: value.pageId }),
    ...(value.assertionId === null ? {} : { assertionId: value.assertionId }),
    sourceId: value.sourceId,
    sourceVersion: value.sourceVersion,
    locator: JSON.stringify(value.locator),
    origin: value.origin,
    ...(value.quote === undefined ? {} : { quote: value.quote }),
  };
  const query = Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `wiki://${encodeURIComponent(value.vaultId)}/${encodeURIComponent(value.revision)}?${query}`;
}

export function decodeWikiPointer(s: string): WikiPointer {
  try {
    // Avoid URL host normalization: vault identifiers are case-sensitive opaque strings.
    const match = /^wiki:\/\/([^/?#]+)\/([^/?#]+)\?([^#]+)$/.exec(s);
    if (!match) throw new Error('expected wiki://vaultId/revision?fields');
    const fields = new Map<string, string>();
    const allowed = new Set(['pageId', 'assertionId', 'sourceId', 'sourceVersion', 'locator', 'origin', 'quote']);
    for (const pair of match[3]!.split('&')) {
      const separator = pair.indexOf('=');
      if (separator < 0) throw new Error('query field must contain =');
      const key = decodeURIComponent(pair.slice(0, separator));
      if (!allowed.has(key) || fields.has(key)) throw new Error(`unknown or duplicate field: ${key}`);
      fields.set(key, decodeURIComponent(pair.slice(separator + 1)));
    }
    if (!fields.has('locator')) throw new Error('missing locator');
    return WikiPointerSchema.parse({
      vaultId: decodeURIComponent(match[1]!),
      revision: decodeURIComponent(match[2]!),
      pageId: fields.get('pageId') ?? null,
      assertionId: fields.get('assertionId') ?? null,
      sourceId: fields.get('sourceId'),
      sourceVersion: fields.get('sourceVersion'),
      locator: JSON.parse(fields.get('locator')!),
      origin: fields.get('origin'),
      ...(fields.has('quote') ? { quote: fields.get('quote')! } : {}),
    });
  } catch (error) {
    throw new Error(`Invalid WikiPointer: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
