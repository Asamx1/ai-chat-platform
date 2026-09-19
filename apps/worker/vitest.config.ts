import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// 直连 DB 的测试；DATABASE_URL 由编排方在运行前 export。

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  test: {
    // claim 是全局队列：worker 测试必须文件级串行，否则互相领取对方的 run。
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/test/debate-e2e.test.ts'],
  },
});
