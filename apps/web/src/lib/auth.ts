import { betterAuth } from 'better-auth';
import type { Adapter, BetterAuthOptions } from 'better-auth';
import { prisma } from '@aichat/db';

/**
 * 手写最小 PrismaAdapter（避免引入 @better-auth/prisma 依赖）。
 *
 * Better Auth 逻辑表 user/session/account/verification 通过 modelMap 映射到
 * Prisma model 名；字段经 fieldMap 映射到 M0 冻结 schema 的列。
 *
 * ⚠️ 已知缺口：M0 冻结的 schema.prisma 只有 User 表，没有 Session/Account/
 * Verification 表。user 表的读写现在即可工作；session/account/verification
 * 的方法已按 better-auth Adapter 接口实现完毕，但对应 Prisma delegate 尚不
 * 存在（用 as any 兜底），等 schema 解冻加表后即可直接工作。
 */

// better-auth 逻辑模型名 → Prisma model（delegate 名）
const modelMap = {
  user: 'user',
  session: 'session',
  account: 'account',
  verification: 'verification',
} as const;

type LogicalModel = keyof typeof modelMap;

// better-auth 字段 → User 表列。未列出的 better-auth 字段（name/image/
// emailVerified 等）在 M0 schema 中没有对应列，写入时直接丢弃。
const userFieldMap: Record<string, string> = {
  id: 'id',
  email: 'email',
  password: 'passwordHash',
  role: 'role',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

function toColumn(model: LogicalModel, field: string): string {
  if (model === 'user') return userFieldMap[field] ?? field;
  return field;
}

/** 递归把 where / data 里的 better-auth 字段名换成 Prisma 列名。 */
function mapKeys(
  model: LogicalModel,
  value: unknown,
  map: (m: LogicalModel, f: string) => string,
): unknown {
  if (Array.isArray(value)) return value.map((v) => mapKeys(model, v, map));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[map(model, k)] = mapKeys(model, v, map);
    }
    return out;
  }
  return value;
}

/** better-auth 的 Where（对象或条件数组）→ Prisma where。 */
function toPrismaWhere(model: LogicalModel, where: unknown): Record<string, unknown> {
  if (Array.isArray(where)) {
    // [{ field, value, operator }] → AND 条件
    const and: Record<string, unknown>[] = [];
    const or: Record<string, unknown>[] = [];
    for (const cond of where as Array<{ field: string; value: unknown; operator?: string; connector?: string }>) {
      const col = toColumn(model, cond.field);
      const clause = buildClause(col, cond.value, cond.operator);
      if (cond.connector === 'OR') or.push(clause);
      else and.push(clause);
    }
    const out: Record<string, unknown> = {};
    if (and.length > 0) out.AND = and;
    if (or.length > 0) out.OR = or;
    return out;
  }
  return mapKeys(model, where, toColumn) as Record<string, unknown>;
}

function buildClause(col: string, value: unknown, operator?: string): Record<string, unknown> {
  switch (operator) {
    case 'gt':
      return { [col]: { gt: value } };
    case 'gte':
      return { [col]: { gte: value } };
    case 'lt':
      return { [col]: { lt: value } };
    case 'lte':
      return { [col]: { lte: value } };
    case 'ne':
      return { [col]: { not: value } };
    case 'contains':
      return { [col]: { contains: value } };
    case 'starts_with':
      return { [col]: { startsWith: value } };
    case 'ends_with':
      return { [col]: { endsWith: value } };
    default:
      return { [col]: value };
  }
}

/** Prisma 行 → better-auth 字段名（反向映射）。 */
function fromPrismaRow(model: LogicalModel, row: unknown): unknown {
  if (model !== 'user' || row === null || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if ('passwordHash' in r) {
    out.password = r.passwordHash;
    delete out.passwordHash;
  }
  return out;
}

// Prisma delegate：user 真实存在；session/account/verification 在 M0 schema
// 中暂缺，用 any 兜底，等 schema 加表后即强类型化。
function delegate(model: LogicalModel): any {
  return (prisma as any)[modelMap[model]];
}

export const prismaAdapter = {
  async create({ model, data }: { model: string; data: Record<string, unknown> }) {
    const m = model as LogicalModel;
    const mapped = mapKeys(m, data, toColumn) as Record<string, unknown>;
    const row = await delegate(m).create({ data: mapped });
    return fromPrismaRow(m, row);
  },
  async findOne({ model, where }: { model: string; where: unknown }) {
    const m = model as LogicalModel;
    const row = await delegate(m).findUnique({ where: toPrismaWhere(m, where) });
    return fromPrismaRow(m, row);
  },
  async findMany({ model, where, limit, sortBy }: { model: string; where?: unknown; limit?: number; sortBy?: { field: string; direction: 'asc' | 'desc' } }) {
    const m = model as LogicalModel;
    const rows = await delegate(m).findMany({
      where: where ? toPrismaWhere(m, where) : undefined,
      take: limit,
      orderBy: sortBy ? { [toColumn(m, sortBy.field)]: sortBy.direction } : undefined,
    });
    return rows.map((r: unknown) => fromPrismaRow(m, r));
  },
  async update({ model, where, update }: { model: string; where: unknown; update: Record<string, unknown> }) {
    const m = model as LogicalModel;
    const row = await delegate(m).update({
      where: toPrismaWhere(m, where),
      data: mapKeys(m, update, toColumn),
    });
    return fromPrismaRow(m, row);
  },
  async updateMany({ model, where, update }: { model: string; where: unknown; update: Record<string, unknown> }) {
    const m = model as LogicalModel;
    return delegate(m).updateMany({
      where: toPrismaWhere(m, where),
      data: mapKeys(m, update, toColumn),
    });
  },
  async delete({ model, where }: { model: string; where: unknown }) {
    const m = model as LogicalModel;
    await delegate(m).delete({ where: toPrismaWhere(m, where) });
  },
  async deleteMany({ model, where }: { model: string; where: unknown }) {
    const m = model as LogicalModel;
    return delegate(m).deleteMany({ where: toPrismaWhere(m, where) });
  },
} as unknown as Adapter;

export const auth = betterAuth({
  database: prismaAdapter,
  // better-auth 逻辑表名映射到 Prisma model 名（User 大写等场景）
  user: {
    modelName: 'User',
    additionalFields: {
      role: { type: 'string', input: false },
    },
  },
  account: {
    modelName: 'Account',
  },
  verification: {
    modelName: 'Verification',
  },
  emailAndPassword: {
    enabled: true,
    // 密码哈希用 better-auth 内置默认（scrypt；argon2 需额外包）
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24, // 1 天
  },
  socialProviders: {}, // 禁用社会登录
  // magic link 默认关闭（未启用 emailAndPassword 之外的能力）
});

export type Session = typeof auth.$Infer.Session;
export type AuthUser = Session['user'];

export type { BetterAuthOptions };
