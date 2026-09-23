import type { EvalCase, QuestionType } from './types';

export type SplitDisclosure = { questionType: QuestionType; total: number; dev: number; heldout: number };

/** Deterministically assign approved cases within each question type to an approximate 70/30 split. */
export function stratifiedSplit(cases: readonly EvalCase[]): { cases: EvalCase[]; counts: SplitDisclosure[] } {
  const types = [...new Set(cases.filter(item => item.reviewStatus === 'APPROVED').map(item => item.questionType))].sort();
  const assignments = new Map<string, EvalCase['split']>();
  const counts = types.map(questionType => {
    const cohort = cases.filter(item => item.reviewStatus === 'APPROVED' && item.questionType === questionType).sort((a, b) => a.id.localeCompare(b.id));
    const dev = Math.round(cohort.length * 0.7);
    cohort.forEach((item, index) => assignments.set(item.id, index < dev ? 'DEV' : 'HELDOUT'));
    return { questionType, total: cohort.length, dev, heldout: cohort.length - dev };
  });
  return { cases: cases.map(item => ({ ...item, split: assignments.get(item.id) ?? item.split })), counts };
}
