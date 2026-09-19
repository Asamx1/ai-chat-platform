/**
 * M7: 客观题判分归一化 —— 剥离思考段、全半角统一、数字/答案抽取。
 * 输出规范化字符串集合，判分 = 规范化答案与规范化参考有交集。
 */

/** 剥离 <think>…</think> 段（qwen3 思考型模型），并 trim。 */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** 全角→半角、去空白、小写。 */
export function normalize(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 从回答中抽取候选答案集合：整串 + 每个数字 + 引号/冒号后的片段。 */
export function extractCandidates(text: string): string[] {
  const base = normalize(stripThinking(text));
  if (!base) return [];
  const out = new Set<string>([base]);
  for (const m of base.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(m[0]);
  // 冒号/是/答案 后的尾巴（"答案是391"→"391"）
  const tail = base.split(/[:：]|答案是?|答案为/).pop();
  if (tail) out.add(tail);
  return Array.from(out);
}

/** 判分：规范化候选与参考任一命中即正确。 */
export function isCorrect(answer: string, ref: string): boolean {
  const refN = normalize(stripThinking(ref));
  if (!refN) return false;
  return extractCandidates(answer).some((c) => c === refN || c.endsWith(refN) || refN.endsWith(c));
}
