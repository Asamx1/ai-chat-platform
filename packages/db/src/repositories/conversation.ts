import type { PrismaClient } from '../generated/client.js';
import type { ConversationCreateInput } from '@aichat/contracts';

export type ConversationListPage = {
  items: Awaited<ReturnType<PrismaClient['conversation']['findMany']>>;
  total: number;
};

export async function createConversation(
  prisma: PrismaClient,
  ownerId: string,
  title: string,
  type: ConversationCreateInput['type'],
) {
  return prisma.conversation.create({
    data: { ownerId, title, type },
  });
}

export async function listConversationsByOwner(
  prisma: PrismaClient,
  ownerId: string,
  pagination: { limit: number; offset: number },
): Promise<ConversationListPage> {
  const { limit, offset } = pagination;
  const [items, total] = await prisma.$transaction([
    prisma.conversation.findMany({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.conversation.count({ where: { ownerId } }),
  ]);
  return { items, total };
}

export async function getConversationWithParticipants(
  prisma: PrismaClient,
  id: string,
) {
  return prisma.conversation.findUnique({
    where: { id },
    include: { participants: true },
  });
}
