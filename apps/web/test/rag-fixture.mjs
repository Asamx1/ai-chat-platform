// Real API/chat modules; mocked Prisma, auth, MinIO SDK, RAG package and provider boundaries.
// SQL constraints, SDK signing, parser quality and live services are NOT exercised here.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const fixture = globalThis.__ragFixture = { session: null, prisma: {}, prompts: [], sdk: [] };
const sources = {
  'next/headers': 'export const headers = async () => new Headers();',
  'next/server': 'export class NextResponse extends Response { static json(body, init) { return new NextResponse(JSON.stringify(body), init); } }',
  '@/lib/auth': 'export const auth = { api: { getSession: async () => globalThis.__ragFixture.session } };',
  '@aichat/db': `const f = globalThis.__ragFixture;
    export const prisma = f.prisma;
    export const createConversation = async () => ({ id: 'conv' });
    export const createMessage = async (_db, conversationId, content) => prisma.message.create({ data: { conversationId, content } });`,
  '@aichat/rag': `export async function retrieve(userId, conversationId, query) {
    const response = await fetch('http://rag.test/retrieve', { method: 'POST', body: JSON.stringify({userId, conversationId, query}) });
    if (!response.ok) throw new Error('internal path');
    return response.json();
  }`,
  minio: `import { Readable } from 'node:stream';
    export class Client {
      constructor(options) { globalThis.__ragFixture.sdk.push(options); }
      async putObject(bucket, key, data, size, meta) {
        const res = await fetch('http://storage.test/' + bucket + '/' + key, { method: 'PUT', body: data, headers: meta });
        if (!res.ok) throw new Error('/private/storage/path');
      }
      async removeObject(bucket, key) { const res = await fetch('http://storage.test/' + bucket + '/' + key, { method: 'DELETE' }); if (!res.ok) throw new Error('private'); }
      async getObject(bucket, key) { const res = await fetch('http://storage.test/' + bucket + '/' + key); return Readable.from([Buffer.from(await res.arrayBuffer())]); }
      listObjectsV2(bucket, prefix, recursive) { globalThis.__ragFixture.listArgs = { bucket, prefix, recursive }; return Readable.from([{ name: prefix + 'doc', lastModified: new Date('2026-09-01') }]); }
    }`,
  '@aichat/providers/quota-provider': `import { OllamaProvider } from '@aichat/providers';
    export const quotaProvider = () => new OllamaProvider();`,
  '@aichat/providers': `const f = globalThis.__ragFixture;
    export const createResolver = () => ({ resolve: async () => ({ adapter: 'ollama', baseUrl: 'http://provider.test', model: 'test' }) });
    export class OllamaProvider {
      capabilities() { return { maxContext: 8192, maxOutput: 1024 }; }
      async *streamChat(messages, options) {
        f.prompts.push({ messages, options });
        yield { type: 'text-delta', delta: 'answer [doc:0]' };
        yield { type: 'done', finishReason: 'stop' };
      }
    }
    export class OpenAICompatibleProvider extends OllamaProvider {}`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in sources) return { url: 'mock:rag:' + specifier, shortCircuit: true };
    if (specifier.startsWith('@/')) return { url: new URL('../src/' + specifier.slice(2) + '.ts', import.meta.url).href, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('mock:rag:')) return { format: 'module', source: sources[url.slice(9)], shortCircuit: true };
    return nextLoad(url, context);
  },
});
