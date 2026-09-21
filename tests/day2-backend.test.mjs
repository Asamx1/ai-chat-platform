import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reserveQuota, finishQuota } from '../packages/providers/src/quota.ts';
import { createResolver } from '../packages/providers/src/resolver.ts';
import { OpenAICompatibleProvider } from '../packages/providers/src/openai-compatible.ts';
const require = createRequire(import.meta.url);
const { executableCandidates, browserExecutable, artifactDir } = require('./browser-paths.cjs');

// Serialized transaction double exercises quota decisions and accounting, not PostgreSQL locking.
function store(limit = 100) {
  const rows = new Map(), calls = new Map(), logs = [], queries = [];
  let tail = Promise.resolve();
  const key = (u,m,d) => JSON.stringify([u,m,d]);
  const tx = {
    async $queryRawUnsafe(sql, ...args) {
      queries.push(sql);
      if (sql.includes('pg_advisory')) return [];
      if (sql.includes('FROM "ProviderCall"')) return [...calls.values()].filter(c => sql.includes('"requestHash"') ? c.hash === args[0] : c.id === args[0]);
      if (sql.includes('FROM "UserModelQuota"')) return limit === null ? [] : [{ dailyLimit: limit }];
      if (sql.includes('FROM "ModelUsageDaily"')) return [rows.get(key(...args))].filter(Boolean);
      throw new Error(sql);
    },
    async $executeRawUnsafe(sql, ...a) {
      queries.push(sql);
      if (sql.startsWith('INSERT INTO "ModelUsageDaily"')) {
        const k = key(a[1],a[2],a[3]);
        if (!rows.has(k)) rows.set(k,{ tokensIn: 0,tokensOut: 0,reservedTokens: 0 });
      } else if (sql.startsWith('INSERT INTO "ProviderCall"')) {
        calls.set(a[0],{ id:a[0], hash:a[3], quotaReservation: JSON.parse(a[4]) });
      } else if (sql.startsWith('UPDATE "ModelUsageDaily"')) {
        const row = rows.get(key(a[0],a[1],a[2]));
        if (sql.includes('"reservedTokens"-$4')) {
          row.reservedTokens -= a[3]; row.tokensIn += a[4]; row.tokensOut += a[5];
        } else row.reservedTokens += a[3];
      } else if (sql.startsWith('UPDATE "ProviderCall"')) calls.get(a[0]).quotaReservation = JSON.parse(a[1]);
      else if (sql.startsWith('INSERT INTO "UsageLog"')) logs.push(a);
      else throw new Error(sql);
      return 1;
    },
  };
  return { ...tx, rows, calls, logs, queries,
    $transaction(fn) { const result = tail.then(() => fn(tx)); tail = result.catch(() => {}); return result; },
  };
}
const input = (hash, extra = {}) => ({ userId:'u', modelId:'m', runId:'r', requestHash:hash, amount:60, cloud:true, attempt:0, seatId:'s', now:new Date('2026-09-21T23:59:59Z'), ...extra });
test('concurrent reservations cannot jointly exceed the limit in serialized transactions', async () => {
  const db = store();
  const results = await Promise.all([reserveQuota(db,input('a')),reserveQuota(db,input('b'))]);
  assert.equal(results.filter(Boolean).length,1);
  assert.equal([...db.rows.values()][0].reservedTokens,60);
  assert.equal(db.calls.size,1);
});
test('zero/default/exact boundary and unsupported amount', async () => {
  assert.equal(await reserveQuota(store(0),input('a')),null);
  assert.ok(await reserveQuota(store(60),input('a')));
  assert.ok(await reserveQuota(store(null),input('a',{ amount:200000 })));
  assert.equal(await reserveQuota(store(null),input('a',{ amount:200001 })),null);
  assert.equal(await reserveQuota(store(),input('a',{ amount:NaN })),null);
});
test('settlement releases once, records actual usage once, and uses reserved UTC day', async () => {
  const db=store(), call=await reserveQuota(db,input('a'));
  const outcome={ tokensIn:10,tokensOut:5,text:'done' };
  await Promise.all([finishQuota(db,call,outcome),finishQuota(db,call,outcome)]);
  assert.deepEqual([...db.rows.values()][0],{ tokensIn:10,tokensOut:5,reservedTokens:0 });
  assert.ok([...db.rows.keys()][0].includes('2026-09-21'));
  assert.equal(db.logs.length,1);
  assert.equal(db.calls.get(call.id).quotaReservation.state,'settled');
  const start=db.queries.findIndex(q=>q.startsWith('SELECT id FROM "ModelUsageDaily"'));
  assert.ok(db.queries[start+1].includes('FROM "ProviderCall"'));
});
test('unknown outcome remains reserved and replay cannot reserve again; known unsent releases', async () => {
  const db=store(), call=await reserveQuota(db,input('a'));
  await assert.rejects(reserveQuota(db,input('a')),/QUOTA_CALL_EXISTS/);
  assert.equal([...db.rows.values()][0].reservedTokens,60);
  await finishQuota(db,call,'not-sent');
  assert.equal([...db.rows.values()][0].reservedTokens,0);
  assert.equal(db.logs.length,0);
});
test('replacement model reserves separately and local usage is counted', async () => {
  const db=store(0), call=await reserveQuota(db,input('local',{ modelId:'local',amount:0,cloud:false }));
  await finishQuota(db,call,{ tokensIn:8,tokensOut:2,text:'local' });
  assert.equal([...db.rows.values()][0].tokensIn,8);
  assert.equal(db.logs.length,1);
});
test('resolver normalizes ids and applies zero, exact limit, reserved tokens, and default', async () => {
  const cloud={ id:'registry',modelKey:'deepseek-chat',providerId:'deepseek',kind:'cloud',baseUrl:null,adapter:'openai-compatible',isDefault:false,provider:{kind:'openai-compatible',baseUrl:'https://api.example'} };
  const local={...cloud,id:'local',kind:'local',adapter:'ollama'};
  for (const [limit,usage,degraded] of [[0,null,true],[100,{tokensIn:80,tokensOut:20},true],[100,{tokensIn:10,tokensOut:10,reservedTokens:80},true],[null,null,false],[300000,{tokensIn:200000,tokensOut:0},false]]) {
    const db={modelRegistry:{findUnique:async()=>cloud,findFirst:async()=>local},apiKey:{findUnique:async()=>null},modelUsageDaily:{findUnique:async()=>usage},userModelQuota:{findUnique:async args=>{assert.equal(args.where.userId_modelId.modelId,'registry');return limit===null?null:{dailyLimit:limit};}}};
    const result=await createResolver(db,{env:{DEEPSEEK_API_KEY:'key'}}).resolve('u','deepseek-chat');
    assert.equal(Boolean(result.degraded),degraded);
  }
});
test('adapter bounds complete UTF-8 input and declines unsupported models', () => {
  const provider=new OpenAICompatibleProvider({baseUrl:'',apiKey:'',model:'deepseek-chat'});
  const messages=[{role:'system',content:'规则'},{role:'user',content:'hello 🌍'}];
  assert.ok(provider.inputTokenUpperBound(messages)>Buffer.byteLength(JSON.stringify(messages)));
  assert.equal(new OpenAICompatibleProvider({baseUrl:'',apiKey:'',model:'deepseek-reasoner'}).inputTokenUpperBound(messages),undefined);
});
test('browser candidates honor environment order and artifact override', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'day2-browser-'));
  try {
    const browser=path.join(dir,'chrome');writeFileSync(browser,'');chmodSync(browser,0o755);
    assert.equal(browserExecutable({PUPPETEER_EXECUTABLE_PATH:browser,CHROME_PATH:'/missing'}),browser);
    assert.deepEqual(executableCandidates({PUPPETEER_EXECUTABLE_PATH:'a',CHROME_PATH:'b'}).slice(0,2),['a','b']);
    assert.ok(executableCandidates({}).includes('/usr/bin/chromium'));
    assert.ok(executableCandidates({}).some(p=>p.startsWith('C:/')));
    assert.equal(artifactDir({E2E_ARTIFACT_DIR:dir}),dir);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('shared execution reserves before HTTP, enforces output cap, settles once and replays without HTTP', async () => {
  const { quotaProvider } = await import('../packages/providers/src/quota-provider.ts');
  const db = store(1000);
  const model = { id:'m',modelKey:'deepseek-chat',providerId:'deepseek',kind:'cloud',baseUrl:'https://api.example',adapter:'openai-compatible',isDefault:false,provider:{kind:'openai-compatible',baseUrl:'https://api.example'} };
  Object.assign(db, {modelRegistry:{findUnique:async()=>model,findFirst:async()=>null},apiKey:{findUnique:async()=>null},modelUsageDaily:{findUnique:async()=>null},userModelQuota:{findUnique:async()=>({dailyLimit:1000})}});
  const savedFetch=globalThis.fetch, savedKey=process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY='test';
  let sends=0;
  globalThis.fetch=async (_url, options)=>{
    sends++;
    assert.equal(db.calls.size,1);
    assert.ok([...db.rows.values()][0].reservedTokens>0);
    assert.equal(JSON.parse(options.body).max_tokens,5);
    return new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  };
  try {
    const input={userId:'u',modelId:'m',runId:'r',attempt:0,seatId:'s',invocation:0};
    const output=[];
    for await (const e of quotaProvider(db,input).streamChat([{role:'user',content:'hello'}],{maxTokens:5})) output.push(e);
    assert.equal(output[0].delta,'answer');assert.equal(sends,1);assert.equal(db.logs.length,1);
    const replay=[];
    for await (const e of quotaProvider(db,{...input,attempt:1}).streamChat([{role:'user',content:'hello'}],{maxTokens:5})) replay.push(e);
    assert.equal(replay[0].delta,'answer');assert.equal(sends,1);assert.equal(db.logs.length,1);
  } finally {globalThis.fetch=savedFetch;if(savedKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=savedKey;}
});
test('unknown network outcome retains the reservation and prevents resend', async () => {
  const { quotaProvider } = await import('../packages/providers/src/quota-provider.ts');
  const db=store(1000), model={id:'m',modelKey:'deepseek-chat',providerId:'deepseek',kind:'cloud',baseUrl:null,adapter:'openai-compatible',isDefault:false,provider:{kind:'openai-compatible',baseUrl:'https://api.example'}};
  Object.assign(db,{modelRegistry:{findUnique:async()=>model,findFirst:async()=>null},apiKey:{findUnique:async()=>null},modelUsageDaily:{findUnique:async()=>null},userModelQuota:{findUnique:async()=>({dailyLimit:1000})}});
  const savedFetch=globalThis.fetch,savedKey=process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='test';let sends=0;
  globalThis.fetch=async()=>{sends++;throw new Error('network outcome unknown');};
  const input={userId:'u',modelId:'m',runId:'r',attempt:0,seatId:'s',invocation:0};
  const run=async()=>{for await(const _ of quotaProvider(db,input).streamChat([{role:'user',content:'hello'}],{maxTokens:5})){};};
  try {
    await assert.rejects(run(),/network outcome unknown/);
    assert.ok([...db.rows.values()][0].reservedTokens>0);
    await assert.rejects(run(),/QUOTA_OUTCOME_UNKNOWN/);assert.equal(sends,1);assert.equal(db.logs.length,0);
  } finally {globalThis.fetch=savedFetch;if(savedKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=savedKey;}
});
