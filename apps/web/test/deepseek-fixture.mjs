// Dependency-free unit harness: imports real application files with boundary mocks.
// Does not emulate Prisma validation, SQL constraints, or real crypto/resolver packages.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const fixture = globalThis.__deepseekFixture = {
  session: { user: { id: 'user-a' } }, prisma: {}, prompts: [], resolutions: [],
  resolved: { adapter: 'openai-compatible', modelId: 'deepseek-chat', model: 'deepseek-chat', apiKey: 'secret', baseUrl: 'https://api.deepseek.com/v1' },
};
const sources = {
  'next/headers': 'export const headers = async () => new Headers();',
  'next/server': 'export class NextResponse extends Response { static json(body, init) { return new NextResponse(JSON.stringify(body), init); } }',
  '@/lib/auth': 'export const auth = { api: { getSession: async () => globalThis.__deepseekFixture.session } };',
  '@aichat/db': `const f = globalThis.__deepseekFixture;
    export const prisma = f.prisma;
    export const createConversation = async () => ({ id: 'conversation-a' });
    export const createMessage = async (_db, conversationId, content) => prisma.message.create({ data: { conversationId, content } });`,
  '@aichat/crypto': `const values = new Map();
    export const encrypt = (key) => { const encrypted = 'v1:mock:encrypted:' + values.size; values.set(encrypted, key); return encrypted; };
    export const decrypt = (value) => values.get(value);
    export const maskKey = (key) => key.length <= 10 ? '***' : key.slice(0,6) + '…' + key.slice(-4);`,
  '@aichat/providers': `const f = globalThis.__deepseekFixture;
    export const DAILY_CLOUD_TOKEN_LIMIT = 200000;
    export const resolver = { resolve: async (...args) => { f.resolutions.push(args); return f.resolve ? f.resolve(...args) : f.resolved; } };
    export const createResolver = () => resolver;
    export class OllamaProvider {
      constructor(options) { this.options = options; }
      async *streamChat(messages) {
        f.prompts.push({ messages, options: this.options });
        yield { type: 'text-delta', delta: 'answer' };
        yield { type: 'usage', usage: { promptTokens: 11, completionTokens: 7, costMicros: 0n } };
        yield { type: 'done', finishReason: 'stop' };
      }
    }
    export class OpenAICompatibleProvider extends OllamaProvider {}`,
  '@aichat/orchestrator': `export class CollabCancelledError extends Error {}
    export async function* runOrchestration(opts) {
      for (const seat of opts.seats) await opts.callModel(seat, opts.userContent, opts.signal);
      yield { type: 'final', output: 'combined' };
    }`,
  'better-auth/crypto': 'export const hashPassword = async (value) => "hashed:" + value;',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in sources) return { url: 'mock:' + specifier, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && !/\.[cm]?[jt]s$/.test(specifier)) {
      const url = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('mock:')) return { format: 'module', source: sources[url.slice(5)], shortCircuit: true };
    return nextLoad(url, context);
  },
});
