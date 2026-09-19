import { prisma } from "@aichat/db";

const u = await prisma.user.upsert({ where: { email: "m4-debate@local" }, update: {}, create: { email: "m4-debate@local", passwordHash: "x" } });
const c = await prisma.conversation.create({ data: { ownerId: u.id, title: "异构辩论", type: "DEBATE" } });
const m = await prisma.message.create({ data: { conversationId: c.id, content: "远程办公是否应该成为公司默认选项？", status: "PENDING" } });
const seats = [
  { seatId: "pro1", modelKey: "qwen3:8b", role: "pro", systemPrompt: "你是正方辩手，论证远程办公应该成为默认选项。给出2-3条有力论据。" },
  { seatId: "con1", modelKey: "qwen2.5:7b", role: "con", systemPrompt: "你是反方辩手，反驳远程办公作为默认选项的立场。给出2-3条有力论据。" },
  { seatId: "judge", modelKey: "qwen3:8b", role: "judge", systemPrompt: "你是公正裁判。基于论证质量（逻辑、证据、针对性）评判双方，用中文总结哪方更有说服力及原因。" }
];
const r = await prisma.orchestrationRun.create({ data: { conversationId: c.id, ownerId: u.id, status: "PENDING", idempotencyKey: "m4-debate-" + Date.now(), configSnapshot: { mode: "DEBATE", content: "远程办公是否应该成为公司默认选项？", userMessageId: m.id, seats, maxRounds: 2 } } });
for (const s of seats) {
  await prisma.runParticipantSnapshot.create({ data: { runId: r.id, seatId: s.seatId, providerKey: "ollama", modelKey: s.modelKey, systemPrompt: s.systemPrompt, params: { role: s.role }, pricingVersion: "local-0" } });
}
console.log("RUN=" + r.id);
await prisma.$disconnect();
