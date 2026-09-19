/**
 * 一次协作运行（run）的 token 预算。
 * - runTokenLimit：整次运行的总 token 上限（本地 Ollama context 32k / 云 API 计费上限）。
 * - perSeatReserve：单个席位允许累计消耗的 token 上限。
 */
export interface Budget {
  runTokenLimit: number;
  perSeatReserve: number;
}

/**
 * 已消耗 token：run 为整次运行累计，seat 为当前席位累计。
 */
export interface UsedTokens {
  run: number;
  seat: number;
}

export type BudgetRejectReason = 'run-limit' | 'seat-reserve';

export interface BudgetDecision {
  allowed: boolean;
  reason?: BudgetRejectReason;
}

/** 超预算时的降级建议序列：先裁历史，再弃席位，最后中止。 */
export const degradeOrder = ['trim-history', 'drop-seat', 'abort'] as const;
export type DegradeStep = (typeof degradeOrder)[number];

/**
 * 粗估 token 数：Math.ceil(text.length/3)。
 * 中文 ~1.5 字/token、英文 ~4 chars/token 的折中。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * 预算检查：
 * - run 累计 + 下次调用预估 > runTokenLimit → 拒（reason 'run-limit'）。
 * - 单席累计 > perSeatReserve → 拒（reason 'seat-reserve'）。
 * run-limit 优先判定（先保全局，再谈席位）。
 */
export function checkBudget(budget: Budget, usedTokens: UsedTokens, nextCallEstimate: number): BudgetDecision {
  if (usedTokens.run + nextCallEstimate > budget.runTokenLimit) {
    return { allowed: false, reason: 'run-limit' };
  }
  if (usedTokens.seat > budget.perSeatReserve) {
    return { allowed: false, reason: 'seat-reserve' };
  }
  return { allowed: true };
}
