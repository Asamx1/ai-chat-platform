import { z } from 'zod';

export const questionTypeSchema = z.enum(['DIRECT_FACT', 'LONG_DOC_LOCAL', 'TABLE_NUMERIC', 'ENTITY_AMBIGUITY', 'RELATION_EVIDENCE', 'CROSS_DOC', 'SYNCHRONY_CONFLICT', 'UNANSWERABLE']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const evidenceAnchorSchema = z.object({
  sourceDocumentId: z.string().min(1), sourceVersionId: z.string().min(1),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  evidenceText: z.string().min(1), evidenceTextHash: z.string().min(1),
}).refine(anchor => anchor.end > anchor.start, { message: 'end must exceed start' });
export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>;

export const evalCaseSchema = z.object({
  id: z.string().min(1), kbId: z.string().min(1), question: z.string().min(1),
  referenceAnswer: z.string().min(1),
  evidenceAnchors: z.array(evidenceAnchorSchema),
  evidenceGroups: z.array(z.array(z.number().int().nonnegative()).min(1)),
  questionType: questionTypeSchema, answerable: z.boolean(),
  origin: z.enum(['LLM_GENERATED', 'HUMAN_AUTHORED']),
  reviewStatus: z.enum(['DRAFT', 'APPROVED', 'REJECTED']),
  split: z.enum(['DEV', 'HELDOUT']),
  reviewedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
}).superRefine((value, context) => {
  if (value.answerable && value.evidenceGroups.length === 0) context.addIssue({ code: 'custom', path: ['evidenceGroups'], message: 'answerable cases need evidence groups' });
  if (!value.answerable && value.evidenceGroups.length !== 0) context.addIssue({ code: 'custom', path: ['evidenceGroups'], message: 'unanswerable cases cannot have evidence groups' });
  if (value.evidenceGroups.some(group => group.some(index => index >= value.evidenceAnchors.length))) context.addIssue({ code: 'custom', path: ['evidenceGroups'], message: 'invalid evidence anchor index' });
  if (value.reviewStatus === 'APPROVED' && !value.reviewedAt) context.addIssue({ code: 'custom', path: ['reviewedAt'], message: 'approved cases need review time' });
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalDatasetSchema = z.object({ version: z.string().min(1), cases: z.array(evalCaseSchema) });
export type EvalDataset = z.infer<typeof evalDatasetSchema>;

export type RetrievalUnit = {
  sourceDocumentId: string; sourceVersionId?: string; start?: number; end?: number;
  text: string; origin?: 'SOURCE' | 'WIKI';
};
