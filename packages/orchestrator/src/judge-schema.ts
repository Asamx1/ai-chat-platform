import { z } from 'zod';
import type { ChatMessage } from './types';

/**
 * Strict verdict schema: extra fields are rejected so a judge model cannot
 * smuggle in unvalidated data.
 */
export const VerdictSchema = z
  .object({
    winner: z.enum(['A', 'B', 'tie']),
    confidence: z.number().min(0).max(1),
    rationale: z.string().max(500),
    divergences: z.array(z.string()).max(5),
  })
  .strict();

export type Verdict = z.infer<typeof VerdictSchema>;

/** Builds the anonymous A/B judging prompt (no seat/model identity leaks to the judge). */
export function buildJudgePrompt(task: string, optionA: string, optionB: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是公正裁判。你的任务是对比两个匿名候选回答并给出裁决。' +
        '只输出一个符合以下 JSON schema 的 JSON 对象，不要输出任何其他文字：' +
        '{"winner":"A"|"B"|"tie","confidence":0到1的数字,"rationale":"不超过500字的理由","divergences":["分歧点",最多5条]}',
    },
    {
      role: 'user',
      content:
        `【任务】\n${task}\n\n` +
        `【选项A】\n${optionA}\n\n` +
        `【选项B】\n${optionB}\n\n` +
        '请比较两个选项对任务的完成质量，输出符合上述 schema 的 JSON（winner 只能是 "A"、"B" 或 "tie"）。',
    },
  ];
}
