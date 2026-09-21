/** GET /api/kb → {items:[{id,name,documents:[D]}],total}（docs/rag-arch.md §4） */
export interface KbDocument {
  id: string;
  name: string;
  status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  chunkCount: number;
  createdAt: string;
  error: string | null;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  documents: KbDocument[];
}

export type KbStatus = KbDocument['status'] | 'EMPTY';

/** KB 级状态聚合：任一 FAILED→FAILED；任在进行中→PROCESSING；否则全 READY→READY；无文档→EMPTY */
export function kbStatus(kb: KnowledgeBase): KbStatus {
  const docs = kb.documents ?? [];
  if (docs.length === 0) return 'EMPTY';
  if (docs.some((d) => d.status === 'FAILED')) return 'FAILED';
  if (docs.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING')) return 'PROCESSING';
  return 'READY';
}

/** 是否仍有解析进行中（列表需要轮询时） */
export function kbBusy(kb: KnowledgeBase): boolean {
  const s = kbStatus(kb);
  return s === 'PENDING' || s === 'PROCESSING';
}

export const KB_STATUS_TEXT: Record<KbStatus, string> = {
  PENDING: '待解析',
  PROCESSING: '解析中',
  READY: '就绪',
  FAILED: '解析失败',
  EMPTY: '空',
};
