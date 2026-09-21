// Dependency-free Node 24 harness for the isolated provider/backend source tests.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@aichat/crypto/constants') {
      return { url: new URL('../packages/crypto/src/constants.ts', import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return nextLoad(url, context);
  },
});
// Optional route-test doubles; production never loads this harness.
if (process.env.DAY2_ROUTE_DOUBLES === '1') registerHooks({
  resolve(specifier, context, nextResolve) {
    const doubles = {
      '@aichat/db': 'export const prisma = globalThis.day2Db;',
      '@/lib/auth': 'export const auth = {api:{getSession:async()=>globalThis.day2Session}};',
      'next/headers': 'export async function headers(){return new Headers();}',
    };
    if (specifier === './auth' && context.parentURL?.endsWith('/lib/admin.ts')) specifier = '@/lib/auth';
    if (doubles[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith('@/lib/')) return { url: new URL('../apps/web/src/lib/' + specifier.slice(6) + '.ts', import.meta.url).href, shortCircuit: true };
    if (specifier === '@aichat/providers/quota' || specifier === '@aichat/providers/resolver') return { url: new URL('../packages/providers/src/' + specifier.split('/').at(-1) + '.ts', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
