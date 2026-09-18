import { z } from 'zod';
import { UsageSchema } from './usage';

export const RUN_EVENT_TYPES = [
  'run.started',
  'run.planning',
  'provider.delta',
  'provider.call.started',
  'provider.call.completed',
  'run.round.completed',
  'judge.result',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'heartbeat',
] as const;

export const RunEventTypeSchema = z.enum(RUN_EVENT_TYPES);

const isoTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'must be an ISO 8601 timestamp',
});

/** Payload schemas per event type (partial — extend as more events gain structure). */
export const ProviderDeltaPayloadSchema = z.object({
  delta: z.string(),
});

export const ProviderCallCompletedPayloadSchema = z.object({
  usage: UsageSchema,
});

export const RunFailedPayloadSchema = z.object({
  error: z.string(),
});

export const RunEventEnvelopeSchema = z.object({
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
  time: isoTime,
  participantId: z.string().optional(),
  round: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type RunEventType = z.infer<typeof RunEventTypeSchema>;
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;
export type ProviderDeltaPayload = z.infer<typeof ProviderDeltaPayloadSchema>;
export type ProviderCallCompletedPayload = z.infer<typeof ProviderCallCompletedPayloadSchema>;
export type RunFailedPayload = z.infer<typeof RunFailedPayloadSchema>;
