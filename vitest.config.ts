import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'experiments/analysis/*.test.ts', 'experiments/runners/*.test.ts'],
  },
});
