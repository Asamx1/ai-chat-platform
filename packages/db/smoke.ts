// M0 冒烟测试：连接 + 建/删用户（PLAN §6.3 关系链路的最小验证，完整链路 M2 集成测试覆盖）
import { prisma } from "./src/index.js";

const email = `smoke-${Date.now()}@test.local`;
const user = await prisma.user.create({
  data: { email, passwordHash: "argon2id-placeholder", role: "USER" },
});
console.log("created user:", user.id, user.email, user.role);
const found = await prisma.user.findUnique({ where: { email } });
console.log("found:", found?.id === user.id);
await prisma.user.delete({ where: { id: user.id } });
const gone = await prisma.user.findUnique({ where: { email } });
console.log("deleted:", gone === null);
const n = await prisma.$queryRaw`SELECT 1 AS ok`;
console.log("raw query ok:", JSON.stringify(n));
await prisma.$disconnect();
console.log("SMOKE PASS");
