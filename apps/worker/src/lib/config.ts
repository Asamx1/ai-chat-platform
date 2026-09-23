/** KB worker tuning (M12-P2); env overrides keep the ops knob, defaults favour throughput. */
const KB_MAX_CONCURRENCY = 8;

export function kbConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.KB_CONCURRENCY);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, KB_MAX_CONCURRENCY)
    : 2;
}
