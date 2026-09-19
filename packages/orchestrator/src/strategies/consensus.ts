import type { ChatMessage, EmitFn, RunContext, SeatConfig, Strategy, StrategyResult } from '../types';

function pickSynthesizer(seats: SeatConfig[]): { synthesizer: SeatConfig; candidates: SeatConfig[] } {
  const explicit = seats.find((s) => s.role === 'synthesizer');
  if (explicit) return { synthesizer: explicit, candidates: seats.filter((s) => s !== explicit) };
  const last = seats[seats.length - 1];
  return { synthesizer: last, candidates: seats.slice(0, -1) };
}

/**
 * Consensus strategy: all candidate seats generate in parallel (Promise.all via
 * allSettled semantics); a synthesizer seat merges the anonymized candidates —
 * it never learns which model produced which candidate. A failed candidate seat
 * degrades the run instead of failing it.
 */
export const consensusStrategy: Strategy = {
  mode: 'CONSENSUS',

  plan(ctx: RunContext) {
    const { synthesizer, candidates } = pickSynthesizer(ctx.seats);
    return {
      steps: [
        `collect candidates from ${candidates.length} seats in parallel`,
        `synthesize final answer via ${synthesizer.seatId} (anonymized candidates)`,
      ],
    };
  },

  async run(ctx: RunContext, emit: EmitFn): Promise<StrategyResult> {
    const { synthesizer, candidates } = pickSynthesizer(ctx.seats);
    const reasons: string[] = [];

    emit('run.planning', { plan: consensusStrategy.plan(ctx).steps });

    const settled = await Promise.all(
      candidates.map(async (seat) => {
        const messages: ChatMessage[] = [
          { role: 'system', content: seat.systemPrompt },
          { role: 'user', content: ctx.userContent },
        ];
        try {
          const content = await ctx.callModel(seat, messages);
          emit('provider.call.completed', { seatId: seat.seatId, content });
          return { seatId: seat.seatId, content };
        } catch (error) {
          const reason = `seat ${seat.seatId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          reasons.push(reason);
          emit('provider.call.completed', { seatId: seat.seatId, failed: true, reason });
          return { seatId: seat.seatId, content: null };
        }
      }),
    );

    const candidateList = settled.filter((c): c is { seatId: string; content: string } =>
      c.content !== null,
    );
    if (candidateList.length === 0) {
      throw new Error('all candidate seats failed');
    }

    // Anonymize: candidates are numbered, with no model key or seat identity.
    const ballot = candidateList
      .map((c, i) => `候选 ${i + 1}:\n${c.content}`)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: synthesizer.systemPrompt },
      { role: 'user', content: ctx.userContent },
      { role: 'user', content: `以下是各候选回答（已匿名），请综合成最终答案：\n\n${ballot}` },
    ];

    const assistantMessageContent = await ctx.callModel(synthesizer, messages, undefined);
    emit('provider.call.completed', { seatId: synthesizer.seatId, content: assistantMessageContent }, 'SYNTHESIZING');

    return {
      assistantMessageContent,
      degraded: reasons.length > 0 || undefined,
      reasons: reasons.length > 0 ? reasons : undefined,
    };
  },
};
