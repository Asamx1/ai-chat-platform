import type { ChatMessage, EmitFn, RunContext, SeatConfig, Strategy, StrategyResult } from '../types';

function seatLabel(seat: SeatConfig): string {
  return `[${seat.seatId}]`;
}

/**
 * Group-chat strategy: seats speak in order; each seat sees the system prompt,
 * all previous utterances (labelled with the speaker's seatId) and the user content.
 * Final answer = output of the summarizer seat (role='summarizer') or the last seat.
 * A failed seat is skipped and the run is marked degraded.
 */
export const groupStrategy: Strategy = {
  mode: 'GROUP',

  plan(ctx: RunContext) {
    const rounds = ctx.maxRounds ?? 1;
    return {
      steps: [
        `plan round-robin over ${ctx.seats.length} seats for ${rounds} round(s)`,
        `collect final answer from ${ctx.seats.find((s) => s.role === 'summarizer') ? "role='summarizer' seat" : 'last seat'}`,
      ],
    };
  },

  async run(ctx: RunContext, emit: EmitFn): Promise<StrategyResult> {
    const rounds = ctx.maxRounds ?? 1;
    const reasons: string[] = [];
    const outputs = new Map<string, string>();
    const history: ChatMessage[] = [];

    emit('run.planning', { plan: groupStrategy.plan(ctx).steps });

    for (let round = 1; round <= rounds; round++) {
      for (const seat of ctx.seats) {
        const messages: ChatMessage[] = [
          { role: 'system', content: seat.systemPrompt },
          ...history,
          { role: 'user', content: ctx.userContent },
        ];
        try {
          const content = await ctx.callModel(seat, messages);
          outputs.set(seat.seatId, content);
          history.push({ role: 'assistant', content: `${seatLabel(seat)} ${content}` });
          emit('provider.call.completed', { seatId: seat.seatId, round, content });
        } catch (error) {
          const reason = `seat ${seat.seatId} failed in round ${round}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          reasons.push(reason);
          emit('provider.call.completed', { seatId: seat.seatId, round, failed: true, reason });
        }
      }
      emit('run.round.completed', { round, seats: ctx.seats.length });
    }

    const finalSeat =
      ctx.seats.find((s) => s.role === 'summarizer') ?? ctx.seats[ctx.seats.length - 1];
    const assistantMessageContent = finalSeat ? outputs.get(finalSeat.seatId) : undefined;
    if (assistantMessageContent === undefined) {
      throw new Error(
        `no seat produced output (final seat ${finalSeat?.seatId ?? 'none'} failed)`
        + (reasons.length > 0 ? `; seat errors: ${reasons.join(' | ')}` : ''),
      );
    }

    return {
      assistantMessageContent,
      degraded: reasons.length > 0 || undefined,
      reasons: reasons.length > 0 ? reasons : undefined,
    };
  },
};
