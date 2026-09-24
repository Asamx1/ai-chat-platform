import { describe, expect, it } from 'vitest';
import {
  DerivedPageMetaSchema, SourceLocatorSchema, SourceMetaSchema, WikiPointerSchema,
  WikiRevisionSchema, decodeWikiPointer, encodeWikiPointer, upgradeLegacyRagCitation,
  type SourceLocator, type WikiPointer,
} from '../src';

const pointer: WikiPointer = {
  vaultId: 'Vault 中文 /?&=#%+', revision: 'rev-001', pageId: null, assertionId: null,
  sourceId: 'src_中文 /?&=#%+', sourceVersion: '版本 /?&=#%+',
  locator: { kind: 'offset', start: 0, end: 10 }, origin: 'sourced',
};
const locators: SourceLocator[] = [
  { kind: 'page', page: 1 }, { kind: 'section', section: '章节/中文 ?&=#%+' },
  { kind: 'offset', start: 0, end: 10 }, { kind: 'time', startSec: 0.5, endSec: 1.25 },
];
const date = '2026-09-24T12:00:00+08:00';
const sha256 = 'aB12'.repeat(16);

describe('Wiki schemas', () => {
  it.each(locators)('accepts locator $kind', (locator) => {
    expect(SourceLocatorSchema.parse(locator)).toEqual(locator);
  });
  it.each([
    { kind: 'page', page: 0 }, { kind: 'page', page: 1.5 },
    { kind: 'section', section: '' }, { kind: 'unknown' },
    { kind: 'offset', start: -1, end: 2 }, { kind: 'offset', start: 2, end: 1 },
    { kind: 'offset', start: 0.5, end: 2 },
    { kind: 'time', startSec: 2, endSec: 1 }, { kind: 'time', startSec: 0, endSec: Infinity },
  ])('rejects invalid locator %#', (locator) => {
    expect(SourceLocatorSchema.safeParse(locator).success).toBe(false);
  });
  it('validates pointer identifiers, origin and quote limit', () => {
    for (const origin of ['sourced', 'inferred']) {
      expect(WikiPointerSchema.safeParse({ ...pointer, origin, quote: '中'.repeat(500) }).success).toBe(true);
    }
    for (const patch of [
      { vaultId: '' }, { revision: 'rev-1' }, { revision: 'rev-abc' },
      { assertionId: 'assertion' }, { sourceId: 'document' }, { sourceVersion: '' },
      { origin: 'derived' }, { quote: '中'.repeat(501) }, { pageId: undefined },
    ]) expect(WikiPointerSchema.safeParse({ ...pointer, ...patch }).success).toBe(false);
  });
  it('validates source metadata and SHA-256', () => {
    const source = { sourceId: 'src_1', familyId: 'family', title: '标题', mimeType: 'text/plain', sha256, addedBy: 'user', createdAt: date };
    expect(SourceMetaSchema.safeParse(source).success).toBe(true);
    for (const patch of [{ sha256: 'g'.repeat(64) }, { sha256: 'a'.repeat(63) }, { sha256: 'a'.repeat(65) }, { addedBy: 'assistant' }, { createdAt: 'yesterday' }]) {
      expect(SourceMetaSchema.safeParse({ ...source, ...patch }).success).toBe(false);
    }
  });
  it('validates derived pages and releases', () => {
    const page = { pageId: 'answers/1', questionHash: 'hash', origin: 'derived', createdAt: date, revision: 'rev-001' };
    expect(DerivedPageMetaSchema.safeParse(page).success).toBe(true);
    expect(DerivedPageMetaSchema.safeParse({ ...page, origin: 'sourced' }).success).toBe(false);
    const release = { revision: 'rev-001', ontologyVersion: '1', rulesVersion: '1', files: [{ path: 'page.md', sha256 }], releasedAt: date };
    expect(WikiRevisionSchema.safeParse(release).success).toBe(true);
    for (const patch of [{ revision: '1' }, { releasedAt: 'invalid' }, { files: [{ path: 'page.md', sha256: 'bad' }] }]) {
      expect(WikiRevisionSchema.safeParse({ ...release, ...patch }).success).toBe(false);
    }
  });
});

describe('WikiPointer encoding', () => {
  it.each(locators)('round trips $kind with Unicode and reserved characters', (locator) => {
    for (const patch of [
      {}, { pageId: '', quote: '' },
      { pageId: '页面 /?&=#%+', assertionId: 'asr_断言 /?&=#%+', quote: '摘录\n中文 /?&=#%+', origin: 'inferred' as const },
    ]) {
      const value = { ...pointer, locator, ...patch };
      const encoded = encodeWikiPointer(value);
      expect(encoded.startsWith('wiki://Vault%20')).toBe(true);
      expect(decodeWikiPointer(encoded)).toEqual(value);
    }
  });
  it('rejects malformed input with error details', () => {
    const encoded = encodeWikiPointer(pointer);
    for (const value of ['', 'https://vault/rev-001', encoded.replace('rev-001', 'bad'),
      encoded.replace('sourceId=src_', 'sourceId=bad'), encoded + '&origin=sourced',
      encoded.replace(/locator=[^&]+/, 'locator=%7B'), encoded + '&quote=%ZZ',
      encoded.replace(/&?sourceVersion=[^&]+/, ''), encoded + '&unknown=x']) {
      expect(() => decodeWikiPointer(value)).toThrow(/Invalid WikiPointer: .+/);
    }
    expect(() => encodeWikiPointer({ ...pointer, revision: 'bad' })).toThrow();
  });
});

describe('legacy RAG compatibility', () => {
  const citation = { documentId: '文档', chunkId: 'chunk-1', kbId: 'kb-1', sourceVersionId: 'version-1', start: 0, end: 10 };
  it('maps persisted legacy provenance and optional quote', () => {
    expect(upgradeLegacyRagCitation(citation)).toEqual({
      vaultId: 'kb-1', revision: 'rev-000', pageId: null, assertionId: null,
      sourceId: 'src_文档', sourceVersion: 'version-1',
      locator: { kind: 'offset', start: 0, end: 10 }, origin: 'sourced',
    });
    expect(upgradeLegacyRagCitation({ ...citation, vaultId: 'vault', sourceVersion: 'hash', quote: '' }))
      .toMatchObject({ vaultId: 'vault', sourceVersion: 'hash', quote: '' });
  });
  it('returns null for malformed or insufficient legacy data', () => {
    for (const value of [null, undefined, [], 'citation', {},
      { documentId: 'doc', ordinal: 0, name: 'name', text: 'text', distance: 0.1 },
      { ...citation, documentId: '' }, { ...citation, kbId: undefined },
      { ...citation, sourceVersionId: undefined }, { ...citation, start: undefined },
      { ...citation, start: 11 }, { ...citation, end: -1 }, { ...citation, quote: 'x'.repeat(501) },
    ]) expect(upgradeLegacyRagCitation(value)).toBeNull();
    expect(upgradeLegacyRagCitation({ get documentId() { throw new Error('bad getter'); } })).toBeNull();
  });
});
