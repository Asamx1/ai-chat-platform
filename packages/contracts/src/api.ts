import { z } from 'zod';

export const ConversationTypeSchema = z.enum(['SINGLE', 'GROUP', 'CONSENSUS', 'DEBATE']);
export const CollabModeSchema = z.enum(['GROUP', 'CONSENSUS', 'DEBATE']);

export const ConversationCreateInputSchema = z.object({
  title: z.string().min(1),
  type: ConversationTypeSchema,
});
export type ConversationCreateInput = z.infer<typeof ConversationCreateInputSchema>;

export const ChatSendInputSchema = z.object({
  conversationId: z.string().min(1),
  content: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type ChatSendInput = z.infer<typeof ChatSendInputSchema>;

export const CollabSeatSchema = z.object({
  seatId: z.string().min(1),
  modelId: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string(),
});

export const CollabCreateRunInputSchema = z.object({
  conversationId: z.string().min(1),
  mode: CollabModeSchema,
  seats: z.array(CollabSeatSchema).min(1),
  tokenBudget: z.number().int().positive(),
});
export type CollabCreateRunInput = z.infer<typeof CollabCreateRunInputSchema>;

export const CollabCancelRunInputSchema = z.object({
  runId: z.string().min(1),
});
export type CollabCancelRunInput = z.infer<typeof CollabCancelRunInputSchema>;

export const CollabReplayRunInputSchema = z.object({
  runId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
});
export type CollabReplayRunInput = z.infer<typeof CollabReplayRunInputSchema>;

export const ProviderTestInputSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .refine((v) => v.providerId !== undefined || v.modelId !== undefined, {
    message: 'either providerId or modelId is required',
  });
export type ProviderTestInput = z.infer<typeof ProviderTestInputSchema>;
