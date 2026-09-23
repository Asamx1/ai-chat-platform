/** Chat send transport settings shared by the server and browser. */
export const CHAT_SSE = {
  contentType: 'text/event-stream',
  pollIntervalMs: 50,
  heartbeatIntervalMs: 15_000,
  batchSize: 128,
} as const;
