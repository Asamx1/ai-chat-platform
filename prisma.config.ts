import path from "node:path";
import "dotenv/config"; // Prisma 7 不再自动加载 .env
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join("packages", "db", "prisma", "schema.prisma"),
  migrations: {
    path: path.join("packages", "db", "prisma", "migrations"),
  },
  // Prisma 7：连接串从 schema 移到 config（datasource 块只允许 provider）
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
