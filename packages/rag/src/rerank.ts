import type { Candidate } from './retrieve';
import { llmJsonArray } from './llm-json';

export async function rerank(query: string, hits: Candidate[], budgetMs = 2_900): Promise<Candidate[]> {
  if (hits.length < 2) return hits;
  try {
    const order = await llmJsonArray(
      `Rank all candidates by relevance to the query. Return a JSON array containing each candidate number exactly once, most relevant first.\n${JSON.stringify({
        query, candidates: hits.map((hit, index) => ({ number: index + 1, text: hit.text.slice(0, 300) })),
      })}`, budgetMs,
    );
    if (order.length !== hits.length || new Set(order).size !== hits.length ||
      !order.every(number => typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= hits.length)) {
      return hits;
    }
    return order.map(number => hits[(number as number) - 1]!);
  } catch { return hits; }
}
