import { randomUUID } from 'node:crypto';
import { DAILY_CLOUD_TOKEN_LIMIT, usageDate } from './resolver';

/** Parameterized SQL contract shared by Prisma and integration-test connections. */
export interface QuotaTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
}
export interface QuotaStore extends QuotaTransaction {
  $transaction<T>(fn: (tx: QuotaTransaction) => Promise<T>): Promise<T>;
}
export interface Reservation {
  userId: string;
  modelId: string;
  date: string;
  amount: number;
  state: 'reserved' | 'settled' | 'released';
  text?: string;
  tokensIn?: number;
  tokensOut?: number;
}
export interface QuotaCall { id: string; quotaReservation: Reservation | null }
export async function lockQuota(tx: QuotaTransaction, userId: string, modelId: string): Promise<void> {
  // A transaction-scoped lock also covers absent overrides and different UTC dates.
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', JSON.stringify([userId, modelId]));
}
export async function findQuotaCall(db: QuotaTransaction, requestHash: string): Promise<QuotaCall | undefined> {
  return (await db.$queryRawUnsafe<QuotaCall[]>('SELECT id,"quotaReservation" FROM "ProviderCall" WHERE "requestHash"=$1', requestHash))[0];
}
export async function reserveQuota(db: QuotaStore, input: {
  userId: string; modelId: string; runId: string; requestHash: string;
  amount: number; cloud: boolean; attempt: number; seatId: string; now?: Date;
}): Promise<QuotaCall | null> {
  if (!Number.isSafeInteger(input.amount) || input.amount < 0 || input.amount > 2147483647) return null;
  return db.$transaction(async tx => {
    await lockQuota(tx, input.userId, input.modelId);
    // Request identity is independent of selected/fallback model, including on retries.
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', input.requestHash);
    const existing = await findQuotaCall(tx, input.requestHash);
    if (existing) throw new Error('QUOTA_CALL_EXISTS');
    const date = usageDate(input.now ?? new Date()).toISOString().slice(0, 10);
    await tx.$executeRawUnsafe(`INSERT INTO "ModelUsageDaily" (id,"userId","modelId",date)
      VALUES ($1,$2,$3,$4::date) ON CONFLICT ("userId","modelId",date) DO NOTHING`, randomUUID(), input.userId, input.modelId, date);
    const [daily] = await tx.$queryRawUnsafe<Array<{ tokensIn: number; tokensOut: number; reservedTokens: number }>>(
      'SELECT "tokensIn","tokensOut","reservedTokens" FROM "ModelUsageDaily" WHERE "userId"=$1 AND "modelId"=$2 AND date=$3::date FOR UPDATE', input.userId, input.modelId, date);
    const [quota] = await tx.$queryRawUnsafe<Array<{ dailyLimit: number }>>(
      'SELECT "dailyLimit" FROM "UserModelQuota" WHERE "userId"=$1 AND "modelId"=$2', input.userId, input.modelId);
    const limit = quota?.dailyLimit ?? DAILY_CLOUD_TOKEN_LIMIT;
    if (input.cloud && (limit === 0 || daily!.tokensIn + daily!.tokensOut + daily!.reservedTokens + input.amount > limit)) return null;
    const reservation: Reservation = { userId: input.userId, modelId: input.modelId, date, amount: input.amount, state: 'reserved' };
    const id = randomUUID();
    await tx.$executeRawUnsafe(`INSERT INTO "ProviderCall" (id,"runId",attempt,"requestHash","quotaReservation","participantSnapshotId")
      VALUES ($1,$2,$3,$4,$5::jsonb,(SELECT id FROM "RunParticipantSnapshot" WHERE "runId"=$2 AND "seatId"=$6 ORDER BY id LIMIT 1))`,
      id, input.runId, input.attempt, input.requestHash, JSON.stringify(reservation), input.seatId);
    await tx.$executeRawUnsafe('UPDATE "ModelUsageDaily" SET "reservedTokens"="reservedTokens"+$4 WHERE "userId"=$1 AND "modelId"=$2 AND date=$3::date', input.userId, input.modelId, date, input.amount);
    return { id, quotaReservation: reservation };
  });
}
/** Unknown outcomes retain their reservation. Only a caller that has not sent can release. */
export async function finishQuota(db: QuotaStore, call: QuotaCall, result: {
  tokensIn: number; tokensOut: number; text: string;
} | 'not-sent'): Promise<void> {
  if (result !== 'not-sent' && ![result.tokensIn, result.tokensOut].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)) throw new Error('INVALID_USAGE');
  const r = call.quotaReservation;
  if (!r) throw new Error('MISSING_RESERVATION');
  await db.$transaction(async tx => {
    await lockQuota(tx, r.userId, r.modelId);
    // Fixed lock order: daily row, then call. Settlement always uses reservation UTC day.
    await tx.$queryRawUnsafe('SELECT id FROM "ModelUsageDaily" WHERE "userId"=$1 AND "modelId"=$2 AND date=$3::date FOR UPDATE', r.userId, r.modelId, r.date);
    const [current] = await tx.$queryRawUnsafe<QuotaCall[]>('SELECT id,"quotaReservation" FROM "ProviderCall" WHERE id=$1 FOR UPDATE', call.id);
    if (current?.quotaReservation?.state !== 'reserved') return;
    const settled = result !== 'not-sent';
    const tokensIn = settled ? result.tokensIn : 0, tokensOut = settled ? result.tokensOut : 0;
    await tx.$executeRawUnsafe(`UPDATE "ModelUsageDaily" SET "reservedTokens"="reservedTokens"-$4,
      "tokensIn"="tokensIn"+$5,"tokensOut"="tokensOut"+$6 WHERE "userId"=$1 AND "modelId"=$2 AND date=$3::date`,
      r.userId, r.modelId, r.date, r.amount, tokensIn, tokensOut);
    await tx.$executeRawUnsafe('UPDATE "ProviderCall" SET "quotaReservation"=$2::jsonb,usage=$3::jsonb,"endedAt"=now() WHERE id=$1',
      call.id, JSON.stringify({ ...r, state: settled ? 'settled' : 'released', ...(settled ? result : {}) }),
      settled ? JSON.stringify({ promptTokens: tokensIn, completionTokens: tokensOut }) : null);
    if (settled) await tx.$executeRawUnsafe(`INSERT INTO "UsageLog" (id,"userId","runId","callId",tokens,"costMicros")
      SELECT $1,$2,"runId",id,$3,0 FROM "ProviderCall" WHERE id=$4`, randomUUID(), r.userId, tokensIn + tokensOut, call.id);
  });
}
