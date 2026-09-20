import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// 数据库集成测试需要仓库根 .env；环境变量由编排方在运行前 export。

export default defineConfig({
  root: rootDir,
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['integration-test/**/*.test.{ts,tsx}'],
  },
});
