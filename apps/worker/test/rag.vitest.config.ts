import { defineConfig } from 'vitest/config';

// Run from repository root. Mock-only tests intentionally skip the DB setup file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/test/runner-rag.test.ts', 'apps/worker/test/collab-rag.test.ts'],
  },
});
