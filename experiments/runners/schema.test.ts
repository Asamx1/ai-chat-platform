import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExperimentManifestSchema, validateManifest } from '../configs/schema';
import { RunResultSchema } from './result-schema';

const examplePath = new URL('../configs/example-manifest.json', import.meta.url);

const validResult = {
  manifestId: 'exp-1',
  conditionId: 'c-single',
  repeat: 0,
  sampleId: 's0',
  startedAt: '2026-09-19T00:00:00.000Z',
  finishedAt: '2026-09-19T00:00:01.000Z',
  status: 'SUCCEEDED',
  output: {
    text: 'answer',
    usage: { promptTokens: 10, completionTokens: 5, costMicros: 100 },
  },
  metrics: { ttftMs: 120, totalMs: 900 },
};

describe('ExperimentManifestSchema', () => {
  it('accepts the example manifest file', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(examplePath), 'utf8'));
    expect(() => validateManifest(raw)).not.toThrow();
    const m = validateManifest(raw);
    expect(m.conditions).toHaveLength(3);
    expect(m.repeats).toBe(3);
    expect(m.seed).toBe(42);
  });

  it('rejects a manifest with missing fields', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(examplePath), 'utf8'));
    delete raw.budget;
    delete raw.seed;
    expect(() => ExperimentManifestSchema.parse(raw)).toThrowError(/budget|seed/);
  });

  it('rejects an out-of-enum condition kind', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(examplePath), 'utf8'));
    raw.conditions[0].kind = 'MAJORITY_VOTE';
    // zod v4 ZodError.message 是 JSON issues 数组：断言 invalid_enum_value + path 指向 kind
    try {
      ExperimentManifestSchema.parse(raw);
      expect.unreachable('should have thrown');
    } catch (e) {
      const issues = JSON.parse((e as Error).message);
      expect(issues.some((i: { code: string; path: string[] }) => i.code === 'invalid_enum_value' || i.code === 'invalid_value' && i.path.join('.').endsWith('kind'))).toBe(true);
    }
  });

  it('validates dataset hash format ^[a-f0-9]{16,64}$', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(examplePath), 'utf8'));
    const cases: Array<[string, boolean]> = [
      ['0123456789abcdef', true], // 16 hex
      ['ABCDEF0123456789', false], // uppercase
      ['0123456789abc', false], // too short (13)
      ['z23456789abcdef', false], // non-hex char
      ['0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123', false], // >64
    ];
    for (const [hash, ok] of cases) {
      const obj = { ...raw, dataset: { ...raw.dataset, hash } };
      expect(ExperimentManifestSchema.safeParse(obj).success).toBe(ok);
    }
  });
});

describe('RunResultSchema', () => {
  it('accepts a valid result', () => {
    expect(RunResultSchema.parse(validResult)).toBeTruthy();
  });

  it('rejects a result with missing fields', () => {
    const { status, ...missing } = validResult;
    void status;
    expect(RunResultSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects an out-of-enum status', () => {
    expect(RunResultSchema.safeParse({ ...validResult, status: 'PENDING' }).success).toBe(false);
  });
});
