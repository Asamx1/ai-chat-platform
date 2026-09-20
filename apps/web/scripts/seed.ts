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
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD?.trim()) {
    console.error('SEED_ADMIN_PASSWORD is required in production');
    process.exit(1);
  }
  if (process.env.NODE_ENV !== 'production' && !process.env.SEED_ADMIN_PASSWORD) {
    console.warn('Using the default development admin password');
  }
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin12345';

  await seedUser(adminEmail, adminPassword, 'ADMIN');
  if (process.env.NODE_ENV !== 'production') {
    await seedUser('demo@example.com', 'demo12345', 'USER');
  }

  await prisma.provider.upsert({
    where: { id: 'deepseek' },
    create: { id: 'deepseek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
    update: { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
  });
  await prisma.provider.upsert({
    where: { id: 'ollama' },
    create: { id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    update: {},
  });
  for (const [modelKey, label, providerId, kind, adapter, baseUrl, isDefault] of [
    ['deepseek-chat', 'DeepSeek Chat', 'deepseek', 'cloud', 'openai-compatible', 'https://api.deepseek.com/v1', false],
    ['deepseek-reasoner', 'DeepSeek Reasoner', 'deepseek', 'cloud', 'openai-compatible', 'https://api.deepseek.com/v1', false],
    ['qwen3:0.6b', 'Qwen3 0.6B', 'ollama', 'local', 'ollama', 'http://127.0.0.1:11434', true],
  ] as const) {
    const data = { kind, adapter, baseUrl, isDefault, capabilities: { label }, pricingVersion: kind === 'local' ? 'local-0' : 'deepseek-v1' };
    await prisma.modelRegistry.upsert({
      where: { providerId_modelKey: { providerId, modelKey } },
      create: { providerId, modelKey, ...data },
      update: data,
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
