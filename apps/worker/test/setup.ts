/** Validate the database before importing Prisma or touching the test queue. */
export function setup(): void {
  const target = process.env.AICHAT_TEST_DB_URL ?? process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !target) {
    throw new Error('Worker tests require NODE_ENV=test and a dedicated _test database');
  }
  const url = new URL(target);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !database.endsWith('_test')) {
    throw new Error('Worker tests require a dedicated database ending in _test');
  }
  process.env.DATABASE_URL = target;
}

export default async function initialize(): Promise<void> {
  setup();
  const { prisma } = await import('@aichat/db');
  await prisma.orchestrationRun.updateMany({
    where: {
      idempotencyKey: { startsWith: 'test-' },
      OR: [
        { status: { in: ['PENDING', 'FAILED'] } },
        { status: 'RUNNING', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }] },
      ],
    },
    data: { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null },
  });
}

// Vitest setupFiles executes the module; it does not invoke its default export.
await initialize();
