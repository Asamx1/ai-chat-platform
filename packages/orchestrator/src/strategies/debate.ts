import type { ChatMessage, EmitFn, RunContext, SeatConfig, Strategy, StrategyResult } from '../types';

interface StanceUtterance {
  stance: 'pro' | 'con';
  round: number;
  content: string;
}

function splitSeats(seats: SeatConfig[]): {
  pro: SeatConfig[];
  con: SeatConfig[];
  judge: SeatConfig;
  extraJudges: number;
} {
  const pro = seats.filter((s) => s.role === 'pro');
  const con = seats.filter((s) => s.role === 'con');
  const judges = seats.filter((s) => s.role === 'judge');
  if (judges.length === 0) {
    throw new Error('debate strategy requires exactly one seat with role=\'judge\' (found 0)');
  }
  return { pro, con, judge: judges[0]!, extraJudges: judges.length - 1 };
}

/**
 * Debate strategy: pro seats argue first (in order), con seats rebut (they see
 * this round's pro arguments), and in later rounds pro may respond to con.
 * After all rounds a single judge seat summarizes — its input is anonymized:
 * utterances carry a pro/con stance label but no model key or seatId.
 * A failed pro/con seat is skipped and degrades the run; a failed judge fails
 * the whole run (no fabricated verdicts).
 */
export const debateStrategy: Strategy = {
  mode: 'DEBATE',

  plan(ctx: RunContext) {
    const rounds = ctx.maxRounds ?? 2;
    const { pro, con, judge, extraJudges } = splitSeats(ctx.seats);
    const steps = [
      `run ${rounds} debate round(s): ${pro.length} pro seat(s) argue, ${con.length} con seat(s) rebut`,
    ];
    if (extraJudges > 0) {
      steps.push(`note: ${extraJudges + 1} judge seats configured, using ${judge.seatId}`);
    }
    steps.push(`judge ${judge.seatId} delivers the anonymized final verdict`);
    return { steps };
  },

  async run(ctx: RunContext, emit: EmitFn): Promise<StrategyResult> {
    const rounds = ctx.maxRounds ?? 2;
    const { pro, con, judge, extraJudges } = splitSeats(ctx.seats);
    const reasons: string[] = [];
    if (extraJudges > 0) {
      reasons.push(`multiple-judges: ${extraJudges + 1} judge seats configured, using the first (${judge.seatId})`);
    }
    if (pro.some((s) => s.modelKey === judge.modelKey) || con.some((s) => s.modelKey === judge.modelKey)) {
      reasons.push('judge-same-model');
    }

    emit('run.planning', { plan: debateStrategy.plan(ctx).steps });

    const transcript: StanceUtterance[] = [];

    const debate = (stance: 'pro' | 'con', seat: SeatConfig, round: number) => {
      const stanceLabel = stance === 'pro' ? '正方' : '反方';
      const history: ChatMessage[] = transcript.map((u) => ({
        role: 'assistant' as const,
        content: `[${u.stance === 'pro' ? '正方' : '反方'}] ${u.content}`,
      }));
      const messages: ChatMessage[] = [
        { role: 'system', content: seat.systemPrompt },
        ...history,
        { role: 'user', content: ctx.userContent },
      ];
      return ctx.callModel(seat, messages).then(
        (content) => {
          transcript.push({ stance, round, content });
          emit('provider.call.completed', { seatId: seat.seatId, round, stance, content });
        },
        (error: unknown) => {
          const reason = `seat ${seat.seatId} failed in round ${round}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          reasons.push(reason);
          emit('provider.call.completed', { seatId: seat.seatId, round, stance, failed: true, reason });
        },
      );
    };

    for (let round = 1; round <= rounds; round++) {
      const seatsDone = { round, seatsDone: 0 };
      for (const seat of pro) {
        await debate('pro', seat, round);
        seatsDone.seatsDone++;
      }
      for (const seat of con) {
        await debate('con', seat, round);
        seatsDone.seatsDone++;
      }
      emit('run.round.completed', { ...seatsDone });
    }

    if (transcript.length === 0) {
      throw new Error('all pro/con seats failed; nothing to judge');
    }

    // Anonymized transcript for the judge: stance labels only, no modelKey/seatId.
    const record = transcript
      .map((u) => `第 ${u.round} 轮 [${u.stance === 'pro' ? '正方' : '反方'}]:\n${u.content}`)
      .join('\n\n');
    const judgeMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `${judge.systemPrompt}\n禁止偏向任何一方，基于论证质量评判。`,
      },
      { role: 'user', content: `${ctx.userContent}\n\n以下是全部轮次发言记录（已匿名）：\n\n${record}` },
    ];

    let verdict: string;
    try {
      verdict = await ctx.callModel(judge, judgeMessages);
    } catch (error) {
      // A failed judge means no honest conclusion exists — fail the whole run.
      throw new Error(`judge seat ${judge.seatId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
    emit('provider.call.completed', { seatId: judge.seatId, content: verdict }, 'JUDGING');
    emit('judge.result', { rounds, judgeModelKey: judge.modelKey });

    return {
      assistantMessageContent: verdict,
      degraded: reasons.length > 0 || undefined,
      reasons: reasons.length > 0 ? reasons : undefined,
    };
  },
};
