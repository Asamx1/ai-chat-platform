import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'experiments/analysis/*.test.ts', 'experiments/runners/*.test.ts'],
    // smoke-real 为真模型重型测试（Ollama 12 题串行），独立跑：pnpm exec vitest run experiments/runners/smoke-real.test.ts
    exclude: ['**/node_modules/**', '**/dist/**', 'experiments/runners/smoke-real.test.ts', 'experiments/runners/collab-smoke.test.ts', 'experiments/runners/exp1-batch.test.ts'],
  },
});
