import { betterAuth } from 'better-auth';
import type { DBAdapter } from 'better-auth';
import { prisma } from '@aichat/db';
import { resolveUseSecureCookies } from './auth-cookies';
import { resolveAuthOriginConfig } from './auth-origin';

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
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
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

/** 剔除 user 对象中的 passwordHash（顶层与嵌套联查都要走这里）。 */
function sanitizeUser(u: Record<string, unknown>): Record<string, unknown> {
  const out = { ...u };
  delete out.passwordHash;
  return out;
}

/** Prisma 行 → better-auth 字段名（反向映射）。 */
function fromPrismaRow(model: LogicalModel, row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  if (model === 'user') {
    const out = sanitizeUser(r);
    // better-auth 期望联查结果里叫 account（单数）；Prisma 关系字段是 accounts。
    if ('accounts' in r && Array.isArray(r.accounts)) {
      out.account = r.accounts;
      delete out.accounts;
    }
    return out;
  }
  if (model === 'session') {
    // session join user：嵌套 user 同样必须脱敏（P9 审查发现的泄漏路径）。
    if (r.user && typeof r.user === 'object') {
      return { ...r, user: sanitizeUser(r.user as Record<string, unknown>) };
    }
  }
  return r;
}

// Prisma delegate：user 真实存在；session/account/verification 在 M0 schema
// 中暂缺，用 any 兜底，等 schema 加表后即强类型化。
function delegate(model: LogicalModel): any {
  return (prisma as any)[modelMap[model]];
}

/** 单一等值条件折叠：{AND:[{id:x}]} → {id:x}，供 update/delete 用（Prisma 单行操作需唯一形状）。 */
function collapseWhere(w: Record<string, unknown>): Record<string, unknown> {
  const and = w.AND as Array<Record<string, unknown>> | undefined;
  if (and && and.length === 1 && Object.keys(w).length === 1) return { ...and[0] };
  return w;
}

/** better-auth 的 join → Prisma include：登录联查 account，get-session 联查 user。 */
function joinToInclude(m: LogicalModel, join?: Record<string, boolean>): Record<string, boolean> | undefined {
  if (!join) return undefined;
  const inc: Record<string, boolean> = {};
  if (m === 'user' && join.account) inc.accounts = true;
  if (m === 'session' && join.user) inc.user = true;
  return Object.keys(inc).length ? inc : undefined;
}

/** cuid2 风格 id（better-auth 期望 adapter 生成主键）。 */
function generateId(): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += c[Math.floor(Math.random() * c.length)];
  return out;
}

export const prismaAdapter = {
  async create({ model, data }: { model: string; data: Record<string, unknown> }) {
    const m = model as LogicalModel;
    const mapped = mapKeys(m, data, toColumn) as Record<string, unknown>;
    // better-auth 不传 id（期望 adapter 侧生成）；Prisma @default(cuid()) 只在
    // client 层生效且该字段无 DDL 默认值，所以这里显式补 cuid 风格 id。
    if (!mapped.id) {
      mapped.id = generateId();
    }
    const row = await delegate(m).create({ data: mapped });
    return fromPrismaRow(m, row);
  },
  async findOne({ model, where, join }: { model: string; where: unknown; join?: Record<string, boolean> }) {
    const m = model as LogicalModel;
    // findFirst 而非 findUnique：better-auth 传任意 where 形状（含 AND 组合），
    // findUnique 只认唯一索引形状会直接抛错（初始化探测就挂在这）。
    const row = await delegate(m).findFirst({
      where: toPrismaWhere(m, where),
      include: joinToInclude(m, join),
    });
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
      where: collapseWhere(toPrismaWhere(m, where)),
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
} as unknown as DBAdapter;

const authOriginConfig = resolveAuthOriginConfig(process.env);
// Secure cookie 跟随已验证的 baseURL 协议；本地 HTTP 冒烟关闭，HTTPS 开启。
// 显式设 AICHAT_SECURE_COOKIES=1 仍可为特殊部署强制开启。
const useSecureCookies = resolveUseSecureCookies(
  { AICHAT_SECURE_COOKIES: process.env.AICHAT_SECURE_COOKIES },
  authOriginConfig,
);

export const auth = betterAuth({
  // better-auth 契约：database 必须是「收到 options、返回 adapter」的函数；
  // 传普通对象会被当成 DB 连接配置走 kysely 路径然后炸掉。
  database: () => prismaAdapter,
  advanced: { useSecureCookies },
  baseURL: authOriginConfig.baseURL,
  trustedOrigins: authOriginConfig.trustedOrigins,
  // 逻辑表名用 better-auth 默认小写（user/session/account/verification），
  // 与 Prisma delegate 名（prisma.user 等）一致；不要设 modelName 覆盖。
  user: {
    additionalFields: {
      role: { type: 'string', input: false },
    },
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


