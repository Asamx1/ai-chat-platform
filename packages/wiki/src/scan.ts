import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import type { PrismaClient } from '@aichat/db';

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const normalizeName = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
export interface RawFile { filePath: string; title: string; sha256: string; bytes: bigint; mimeType: string }
export async function database(): Promise<PrismaClient> { return (await import('@aichat/db')).prisma; }
const mimeTypes: Record<string, string> = { '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
  '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp' };

export async function rawPath(vaultPath: string, relPath: string): Promise<string> {
  if (!/^raw\/(articles|papers|transcripts)\//u.test(relPath.replaceAll('\\', '/'))) throw new Error('PATH_OUTSIDE_RAW');
  const root = await realpath(vaultPath);
  const file = await realpath(resolve(root, relPath));
  const rel = relative(root, file);
  if (rel.startsWith(`..${sep}`) || rel === '..' || !/^raw\/(articles|papers|transcripts)\//u.test(rel.split(sep).join('/'))) throw new Error('PATH_OUTSIDE_RAW');
  return file;
}
export async function scanRawFile(vaultPath: string, relPath: string): Promise<RawFile> {
  const file = await rawPath(vaultPath, relPath);
  const mimeType = mimeTypes[extname(file).toLowerCase()];
  if (!mimeType) throw new Error('UNSUPPORTED_FILE_TYPE');
  const data = await readFile(file);
  return { filePath: relative(await realpath(vaultPath), file).split(sep).join('/'), title: basename(file, extname(file)),
    sha256: sha256(data), bytes: BigInt(data.byteLength), mimeType };
}
export async function scanRawDir(vaultPath: string): Promise<RawFile[]> {
  const paths = await listRawFiles(vaultPath);
  return Promise.all(paths.map(path => scanRawFile(vaultPath, path)));
}
export async function listRawFiles(vaultPath: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(resolve(vaultPath, dir), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && mimeTypes[extname(entry.name).toLowerCase()]) files.push(path);
    }
  }
  for (const category of ['articles', 'papers', 'transcripts']) await walk(`raw/${category}`);
  return files.sort();
}
export async function registerSource(file: RawFile, vaultId: string, db?: PrismaClient) {
  const client = db ?? await database();
  const familyKey = sha256(normalizeName(file.title)).slice(0, 16);
  try { return await client.$transaction(async tx => {
    // Serialize a family, including the first insert. A duplicate does not update any row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([vaultId, familyKey])}, 0))`;
    const existingFamily = await tx.vaultSourceFamily.findUnique({ where: { vaultId_familyKey: { vaultId, familyKey } } });
    if (existingFamily) {
      const source = await tx.vaultSource.findUnique({ where: { vaultId_familyId_sha256: { vaultId, familyId: existingFamily.id, sha256: file.sha256 } } });
      if (source) return { source, family: existingFamily, isDuplicate: true };
    }
    const family = await tx.vaultSourceFamily.upsert({ where: { vaultId_familyKey: { vaultId, familyKey } },
      create: { vaultId, familyKey, title: file.title }, update: { title: file.title } });
    const source = await tx.vaultSource.create({ data: { ...file, id: `src_${randomUUID()}`, vaultId, familyId: family.id } });
    return { source, family, isDuplicate: false };
  }); } catch (error) {
    // Also handle a concurrent writer that does not use our advisory lock.
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
    const family = await client.vaultSourceFamily.findUnique({ where: { vaultId_familyKey: { vaultId, familyKey } } });
    if (!family) throw error;
    const source = await client.vaultSource.findUnique({ where: { vaultId_familyId_sha256: { vaultId, familyId: family.id, sha256: file.sha256 } } });
    if (!source) throw error;
    return { source, family, isDuplicate: true };
  }
}
