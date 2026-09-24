import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@aichat/db';
import type { Ontology } from '@aichat/ontology';
import { defaultConstraints, extractAssertions } from '../src/extract.js';
import { scanRawDir } from '../src/scan.js';
import { describeImage, ingestMultimodal, ocrFile, parseSubtitles } from '../src/multimodal.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _opts, callback) => callback(new Error('PDF_RENDERER_UNAVAILABLE'))) }));
vi.mock('../src/scan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/scan.js')>();
  return { ...actual, registerSource: vi.fn(async file => ({ source: { ...file, id: 'src_fixture', familyId: 'family_fixture' }, family: { id: 'family_fixture' }, isDuplicate: false })) };
});
vi.mock('../src/extract.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/extract.js')>();
  return { ...actual, extractAssertions: vi.fn(actual.extractAssertions),
    normalizeEntities: vi.fn(async () => ({ ids: new Map(), entitiesCreated: 0, entitiesMerged: 0 })) };
});
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(name: string, content: string) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-multimodal-')); roots.push(root);
  await mkdir(join(root, 'raw/transcripts'), { recursive: true });
  const path = `raw/transcripts/${name}`; await writeFile(join(root, path), content);
  return { root, path };
}
const srt = '1\r\n00:00:01,250 --> 00:00:03,500\r\nHello world\r\n\r\n2\r\n01:02:03,000 --> 01:02:05,100\r\nSecond cue\r\n';
const options = () => ({
  db: { $transaction: async (fn: (tx: object) => Promise<unknown>) => fn({}) } as unknown as PrismaClient,
  ontology: { version: '1', classes: [], endpointRoles: [], relations: [] } as unknown as Ontology,
  constraints: defaultConstraints,
  llm: vi.fn(async () => ({ entities: [], assertions: [] })),
  normalizeLlm: vi.fn(async () => ({ entities: [] })),
  visionLlm: vi.fn(async () => ({ text: 'Visible text', confidence: 0.95 })),
});
describe('multimodal ingestion', () => {
  it('parses inline SRT, preserves milliseconds and emits locators', async () => {
    const f = await fixture('captions.srt', srt);
    const result = await parseSubtitles(f.root, f.path);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({ startMs: 1250, endMs: 3500, text: 'Hello world', locator: 'subtitle:00:00:01-00:00:03' });
    expect(result.entries[1]!.startMs).toBe(3723000);
    expect(result.qualityInsufficient).toBe(false);
    const registered = await parseSubtitles(f.root, f.path, { sourceId: 'src_fixture' });
    expect(JSON.parse(await readFile(join(f.root, 'extracted/src_fixture/subtitles.json'), 'utf8'))).toEqual(registered.entries);
  });
  it('supports VTT headers, identifiers, settings, and rejects malformed cues', async () => {
    const f = await fixture('captions.vtt', 'WEBVTT\n\nNOTE comment\nignored\n\ncue-a\n00:01.000 --> 00:03.000 align:start\n<b>Hello</b>\n\nbad\n00:99.000 --> 00:04.000\nbroken');
    const result = await parseSubtitles(f.root, f.path);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.text).toBe('Hello');
    expect(result.coverage).toBe(0.5);
    expect(result.qualityInsufficient).toBe(true);
  });
  it('writes OCR output using an injected LLM without a real visual service', async () => {
    const f = await fixture('scan.png', 'mock image');
    const llm = vi.fn(async () => ({ text: 'Fixed OCR text', confidence: 0.9 }));
    const result = await ocrFile(f.root, f.path, { llm, sourceId: 'src_fixture' });
    expect(result).toMatchObject({ backendUsed: 'llm', textLength: 14, qualityInsufficient: false });
    expect(result.pages).toEqual([{ page: 1, text: 'Fixed OCR text', confidence: 0.9 }]);
    expect(await readFile(join(f.root, 'extracted/src_fixture/ocr.txt'), 'utf8')).toBe('[page:1]\nFixed OCR text');
    expect(llm).toHaveBeenCalledOnce();
  });
  it.each(['srt', 'png', 'tiff'])('routes %s through the shared extraction pipeline', async ext => {
    const f = await fixture(`source.${ext}`, ext === 'srt' ? srt : 'mock image');
    const opts = options();
    const report = await ingestMultimodal(f.root, f.path, opts);
    expect(report).toMatchObject({ state: 'ingested', sourceType: 'multimodal', sourceId: 'src_fixture' });
    const doc = vi.mocked(extractAssertions).mock.calls[0]![0];
    expect(doc.sections[0]!.locator).toEqual(ext === 'srt' ? { kind: 'time', startSec: 1.25, endSec: 3.5 } : ext === 'png' ? { kind: 'section', section: 'image:source.png' } : { kind: 'page', page: 1 });
    expect(opts.visionLlm).toHaveBeenCalledTimes(ext === 'srt' ? 0 : 1);
    expect((await scanRawDir(f.root)).map(file => file.filePath)).toContain(f.path);
  });
  it.each([0.1, undefined])('does not extract assertions with low or missing confidence (%s)', async score => {
    const f = await fixture('unclear.png', 'mock image');
    const opts = options();
    const report = await ingestMultimodal(f.root, f.path, { ...opts, visionLlm: async () => ({ text: 'Uncertain text', confidence: score }) });
    expect(report.qualityInsufficient).toBe(true);
    expect(report.assertionsAccepted).toEqual([]);
    expect(report.reasons?.length).toBeGreaterThan(0);
    expect(extractAssertions).not.toHaveBeenCalled();
    expect(opts.llm).not.toHaveBeenCalled();
  });
  it('blocks assertions for low subtitle coverage and reports vision failure honestly', async () => {
    const f = await fixture('empty.srt', '1\ninvalid timing\ntext');
    const report = await ingestMultimodal(f.root, f.path, options());
    expect(report).toMatchObject({ qualityInsufficient: true, reasons: ['LOW_SUBTITLE_CUE_COVERAGE'], assertionsAccepted: [] });
    const image = await fixture('broken.jpg', 'mock');
    const failed = await ingestMultimodal(image.root, image.path, { ...options(), visionLlm: async () => { throw new Error('VISION_UNAVAILABLE'); } });
    expect(failed).toMatchObject({ needsOcr: true, qualityInsufficient: true, reasons: ['VISION_UNAVAILABLE'] });
    expect(extractAssertions).not.toHaveBeenCalled();
  });
  it('routes PDFs to page rendering and reports an unavailable renderer without inventing OCR', async () => {
    const f = await fixture('scan.pdf', '%PDF mock');
    const opts = options();
    const report = await ingestMultimodal(f.root, f.path, opts);
    expect(report).toMatchObject({ needsOcr: true, qualityInsufficient: true, reasons: ['PDF_RENDERER_UNAVAILABLE'], assertionsAccepted: [] });
    expect(opts.visionLlm).not.toHaveBeenCalled();
    expect(extractAssertions).not.toHaveBeenCalled();
  });
  it('writes image descriptions with optional OCR and a stable image locator', async () => {
    const f = await fixture('diagram.png', 'mock image');
    const result = await describeImage(f.root, f.path, { sourceId: 'src_fixture', includeOcr: true, visionLlm: async () => ({ text: 'A diagram', ocr: 'Label', confidence: 0.9 }) });
    expect(result.locator).toBe('image:diagram.png');
    expect(await readFile(join(f.root, 'extracted/src_fixture/images/diagram.png.md'), 'utf8')).toContain('A diagram\n\nLabel');
  });
});
