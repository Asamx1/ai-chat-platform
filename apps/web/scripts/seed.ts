/**
 * 本地开发种子脚本（幂等，upsert）：
 *   pnpm --filter @aichat/web seed
 *
 * 管理员邮箱/密码读 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 * （默认 admin@example.com / admin12345，仅限本地开发）。
 *
 * 密码哈希直接复用 better-auth 的 hashPassword（scrypt 同族），
 * 保证种子账号可经 /api/auth/sign-in/email 正常登录。
 */
import { hashPassword } from 'better-auth/crypto';
import { prisma } from '@aichat/db';

async function seedUser(email: string, password: string, role: 'ADMIN' | 'USER'): Promise<void> {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role, passwordHash },
    create: { email, passwordHash, role },
  });
  // better-auth 邮箱密码登录从 Account(providerId='credential', issuer='local:credential') 取密码：
  // upsert 同步这行，accountId 必须=userId。
  const credentialIssuer = 'local:credential';
  await prisma.account.upsert({
    where: { providerId_accountId: { providerId: 'credential', accountId: user.id } },
    update: { password: passwordHash, issuer: credentialIssuer },
    create: {
      id: `acct-${user.id}`,
      userId: user.id,
      accountId: user.id,
      providerId: 'credential',
      password: passwordHash,
      issuer: credentialIssuer,
    },
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
