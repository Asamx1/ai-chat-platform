import { llmJsonArray } from './llm-json';

export async function rewriteQuery(query: string, budgetMs = 2_900): Promise<string[]> {
  try {
    const result = await llmJsonArray(
      `Rewrite the query into 2 or 3 distinct search paraphrases in the same language, preserving meaning. Do not answer it or invent facts. Return a JSON array of strings.\nQuery: ${JSON.stringify(query)}`,
      budgetMs,
    );
    if (result.length < 2 || result.length > 3 || !result.every(text => typeof text === 'string' && text.trim().length > 0)) {
      return [query];
    }
    const paraphrases = [...new Set((result as string[]).map(text => text.trim()))];
    return paraphrases.length >= 2 ? paraphrases : [query];
  } catch { return [query]; }
}
