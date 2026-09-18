import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

// Prisma 7：client 必须显式持有 driver adapter（无 Rust 引擎直连连串模式）。
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient };
export type { Prisma } from "./generated/client";
export * from "./repositories/index";
