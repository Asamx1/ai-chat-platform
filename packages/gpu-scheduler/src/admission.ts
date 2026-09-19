/**
 * Admission control: decide whether a model load request fits in VRAM,
 * possibly by evicting a currently loaded model.
 */

import { estimateVram } from './ollama-client';

export interface AdmissionRequest {
  modelName: string;
  estContextTokens: number;
}

export interface RunningModelSnapshot {
  name: string;
  sizeBytes: number;
}

export interface VramSnapshot {
  running: RunningModelSnapshot[];
  /** Defaults to 24 GB when unknown. */
  totalVramBytes?: number;
}

export type AdmissionReason = 'ok' | 'already-loaded' | 'insufficient-vram' | 'would-oom';

export interface AdmissionDecision {
  admitted: boolean;
  reason: AdmissionReason;
  evictCandidate?: string;
}

/** Fallback estimate when the model name carries no recognizable param count. */
const DEFAULT_MODEL_BYTES = 8 * 1024 ** 3;

const DEFAULT_TOTAL_VRAM_BYTES = 24 * 1024 ** 3;

/** estimateVram(modelName) + estContextTokens * 2 bytes, in bytes. */
export function estimateRequiredBytes(req: AdmissionRequest): number {
  const est = estimateVram(req.modelName);
  const modelBytes = est ? est.estimatedGB * 1024 ** 3 : DEFAULT_MODEL_BYTES;
  return Math.round(modelBytes + req.estContextTokens * 2);
}

export function decide(req: AdmissionRequest, snapshot: VramSnapshot): AdmissionDecision {
  // Rule 1: same-name model already resident → pass through.
  if (snapshot.running.some((m) => m.name === req.modelName)) {
    return { admitted: true, reason: 'already-loaded' };
  }

  const totalVramBytes = snapshot.totalVramBytes ?? DEFAULT_TOTAL_VRAM_BYTES;
  const required = estimateRequiredBytes(req);

  // Demand larger than the whole card can never fit, even with evictions.
  if (required > totalVramBytes) {
    return { admitted: false, reason: 'would-oom' };
  }

  const usedBytes = snapshot.running.reduce((sum, m) => sum + m.sizeBytes, 0);
  if (usedBytes + required <= totalVramBytes) {
    return { admitted: true, reason: 'ok' };
  }

  // Not enough free VRAM: try evicting the largest non-target resident model.
  const evictable = snapshot.running
    .filter((m) => m.name !== req.modelName)
    .reduce<RunningModelSnapshot | null>(
      (largest, m) => (!largest || m.sizeBytes > largest.sizeBytes ? m : largest),
      null,
    );
  if (evictable && usedBytes - evictable.sizeBytes + required <= totalVramBytes) {
    return { admitted: true, reason: 'ok', evictCandidate: evictable.name };
  }

  return { admitted: false, reason: 'insufficient-vram' };
}
