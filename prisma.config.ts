import path from "node:path";

export default {
  schema: path.join("packages", "db", "prisma", "schema.prisma"),
  migrations: {
    path: path.join("packages", "db", "prisma", "migrations"),
  },
};
