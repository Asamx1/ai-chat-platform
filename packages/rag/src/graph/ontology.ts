import { prisma } from '@aichat/db';
import { z } from 'zod';

export interface GraphSql {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}
const rule = z.object({ direction: z.enum(['directed', 'symmetric']), subjects: z.array(z.string()).min(1), objects: z.array(z.string()).min(1), timeRequired: z.boolean().default(false), conditionRequired: z.boolean().default(false) });
export const ontologySchema = z.object({ version: z.string().min(1), entityTypes: z.array(z.string()).min(1), relations: z.record(z.string(), rule) }).refine(s => Object.values(s.relations).every(r => [...r.subjects, ...r.objects].every(t => s.entityTypes.includes(t))), 'Unknown endpoint type');
export type Ontology = z.infer<typeof ontologySchema>;
const types = ['人物', '组织', '产品', '技术', '概念'];
const directed = (subjects: string[], objects: string[]) => ({ direction: 'directed' as const, subjects, objects, timeRequired: false, conditionRequired: false });
export const DEFAULT_ONTOLOGY: Ontology = { version: 'v1', entityTypes: types, relations: {
  member_of: directed(['人物', '组织'], ['组织']), develops: directed(['人物', '组织'], ['产品', '技术']),
  uses: directed(['人物', '组织', '产品', '技术'], ['产品', '技术', '概念']),
  competes_with: { ...directed(['组织', '产品'], ['组织', '产品']), direction: 'symmetric' },
  depends_on: directed(types, types), part_of: directed(types, types),
} };
export async function loadOntology(kbId: string, db: GraphSql = prisma): Promise<Ontology> {
  const [row] = await db.$queryRawUnsafe<{ version: string; schemaJson: unknown }[]>(`SELECT version,"schemaJson" FROM "OntologyConfig" WHERE "kbId"=$1 ORDER BY "createdAt" DESC,id DESC LIMIT 1`, kbId);
  return row ? ontologySchema.parse({ ...(row.schemaJson as object), version: row.version }) : DEFAULT_ONTOLOGY;
}
export const normalizeName = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
