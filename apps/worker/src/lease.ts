import { prisma } from '@aichat/db';

/**
 * DB lease 领取 / 续租 / 取消查询。
 *
 * 原子性：claimNextRun 是单条 UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * 语句——行锁由数据库在子查询里获取，SKIP LOCKED 让并发 worker 跳过已被锁的行，
 * 各自领到不同的 run；UPDATE 本身设置 leaseOwner/leaseExpiresAt/status/attempt，
 * 领取与租约写入是同一原子操作，不存在“看到但没领到”的窗口。
 */

export const LEASE_TTL_SECONDS = 30;

/** 原子领取下一个可执行的 run（PENDING，或租约过期的 RUNNING）。返回 runId | null。 */
export async function claimNextRun(workerId: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE "OrchestrationRun"
       SET "leaseOwner" = $1,
           "leaseExpiresAt" = now() + interval '${LEASE_TTL_SECONDS} seconds',
           "status" = 'RUNNING',
           "attempt" = "attempt" + 1
     WHERE id = (
       SELECT id FROM "OrchestrationRun"
        WHERE ("status" = 'PENDING'
               OR ("status" IN ('RUNNING', 'FAILED')
                   AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
                   AND "attempt" < 3))
          AND "cancelRequested" = false
        ORDER BY "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    workerId,
  );
  return rows.length > 0 ? rows[0]!.id : null;
}

/** 续租。返回受影响行数；0 表示租约已丢失（被其他 worker 接管）。 */
export async function renewLease(runId: string, workerId: string): Promise<number> {
  const count = await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun"
       SET "leaseExpiresAt" = now() + interval '${LEASE_TTL_SECONDS} seconds'
     WHERE id = $1 AND "leaseOwner" = $2`,
    runId,
    workerId,
  );
  return count;
}

/** 是否已请求取消。run 不存在视为无需取消。 */
export async function shouldCancel(runId: string): Promise<boolean> {
  const run = await prisma.orchestrationRun.findUnique({
    where: { id: runId },
    select: { cancelRequested: true },
  });
  return run?.cancelRequested ?? false;
}

/** 释放租约（结束/失败/取消后调用）。 */
export async function releaseLease(runId: string, workerId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "OrchestrationRun"
       SET "leaseOwner" = NULL, "leaseExpiresAt" = NULL
     WHERE id = $1 AND "leaseOwner" = $2`,
    runId,
    workerId,
  );
}
