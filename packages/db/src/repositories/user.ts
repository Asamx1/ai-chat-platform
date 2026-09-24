import type { PrismaClient } from '../generated/client';
import type { Role } from '../generated/enums';

export type UserRecord = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
};

export async function createUser(
  prisma: PrismaClient,
  email: string,
  passwordHash: string,
  role: Role = 'USER',
): Promise<UserRecord> {
  return prisma.user.create({
    data: { email, passwordHash, role },
  });
}

export async function findUserByEmail(
  prisma: PrismaClient,
  email: string,
): Promise<UserRecord | null> {
  return prisma.user.findUnique({
    where: { email },
  });
}

export async function findUserById(
  prisma: PrismaClient,
  id: string,
): Promise<UserRecord | null> {
  return prisma.user.findUnique({
    where: { id },
  });
}
