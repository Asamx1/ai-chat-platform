/**
 * worker 测试全局 setup：独立测试库 + 队列清空。
 * 根治共享队列表的跨文件/跨轮 flaky（M4 day1 已知问题）。
 * 环境变量 AICHAT_TEST_DB_URL 未设时跳过（向后兼容本地直跑）。
 */
import { execSync } from 'node:child_process';

const TEST_DB = process.env.AICHAT_TEST_DB_URL ?? '';

export function setup(): void {
  if (TEST_DB) {
    process.env.DATABASE_URL = TEST_DB;
  }
}

export default function (): void {
  setup();
  // 清空测试库的可领队列（幂等；无测试库时清主库窗口内可领 run）
  try {
    const drain = `UPDATE "OrchestrationRun" SET status='CANCELLED', "leaseOwner"=NULL WHERE status IN ('PENDING','FAILED') OR (status='RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now() + interval '5 seconds'))`;
    execSync(
      `docker exec aichat-postgres psql -U aichat -d ${TEST_DB ? 'aichat_test' : 'aichat'} -c "${drain.replace(/"/g, '\\"')}"`,
      { stdio: 'ignore' },
    );
  } catch {
    // docker 不可用时静默（vitest 内 drain 兜底）
  }
}
