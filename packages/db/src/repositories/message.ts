import type { PrismaClient } from '../generated/client';
import type { MessageStatus } from '../generated/enums';

export async function createMessage(
  prisma: PrismaClient,
  conversationId: string,
  content: string,
  participantId?: string,
) {
  return prisma.message.create({
    data: {
      conversationId,
      content,
      status: 'PENDING',
      participantId: participantId ?? null,
    },
  });
}

/**
 * 按 createdAt 游标分页拉取会话消息（afterSeq 语义用 createdAt 游标实现，
 * 传上一页最后一条的 createdAt）。返回按 createdAt 升序。
 */
export async function listMessages(
  prisma: PrismaClient,
  conversationId: string,
  options: { afterCreatedAt?: Date; limit?: number } = {},
) {
  const { afterCreatedAt, limit = 50 } = options;
  return prisma.message.findMany({
    where: {
      conversationId,
      ...(afterCreatedAt ? { createdAt: { gt: afterCreatedAt } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export async function updateMessageStatus(
  prisma: PrismaClient,
  id: string,
  status: MessageStatus,
) {
  return prisma.message.update({
    where: { id },
    data: { status },
  });
}
