/**
 * 本地开发种子脚本（幂等，upsert）：
 *   pnpm --filter @aichat/web seed
 *
 * 管理员邮箱/密码读 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 * （默认 admin@example.com / admin12345，仅限本地开发）。
 *
 * 密码用 node:crypto scrypt（32 字节随机盐），格式 salt:hash（base64），
 * 与 better-auth 的内置哈希不同——这两个账号仅作数据种子，实际登录请在
 * 正式接入 better-auth 哈希后再统一（见 auth.ts 注释）。
 */
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from '@aichat/db';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('base64')}:${hash.toString('base64')}`;
}

async function seedUser(email: string, password: string, role: 'ADMIN' | 'USER'): Promise<void> {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role, passwordHash },
    create: { email, passwordHash, role },
  });
  console.log(`seeded ${role} user ${email} (id=${user.id})`);
}

async function main(): Promise<void> {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin12345';

  await seedUser(adminEmail, adminPassword, 'ADMIN');
  await seedUser('demo@example.com', 'demo12345', 'USER');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
