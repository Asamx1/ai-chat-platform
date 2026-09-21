import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const actor = { id:'a',email:'a@example.com',role:'ADMIN',disabled:false };
const target = { ...actor,id:'b' };
let mutations, revoked, quotaLimit, adminCount, calls;
globalThis.day2Db = {
  user: {
    findUnique: async ({where}) => where.id==='missing' ? null : where.id==='a' ? actor : target,
    findMany: async () => [actor,target], count: async () => adminCount,
    update: async ({data}) => {mutations++;return {...target,...data};},
  },
  session: {deleteMany:async ({where})=>{revoked=where.userId;}},
  modelRegistry:{findUnique:async ({where})=>where.id==='missing'?null:{id:where.id},findMany:async()=>[{id:'m'},{id:'n'}]},
  userModelQuota:{findMany:async()=>[{modelId:'m',dailyLimit:0}],upsert:async ({create})=>{quotaLimit=create.dailyLimit;return create;},deleteMany:async()=>{quotaLimit=null;}},
  $queryRaw:async (strings,...values)=>{calls.push([strings.join('?'),values]);return strings.join('').includes('SUM(')?[{date:new Date('2026-09-21'),userId:'a',modelId:'m',tokens:4294967294n}]:[];},
  $queryRawUnsafe:async (...args)=>{calls.push(args);return [];},
  $transaction:async fn=>fn(globalThis.day2Db),
};
const {GET:users}=await import('../apps/web/src/app/api/admin/users/route.ts');
const {PATCH}=await import('../apps/web/src/app/api/admin/users/[id]/route.ts');
const {GET:quotas}=await import('../apps/web/src/app/api/admin/quotas/route.ts');
const {PUT,DELETE}=await import('../apps/web/src/app/api/admin/quotas/[userId]/[modelId]/route.ts');
const {GET:usage}=await import('../apps/web/src/app/api/admin/usage/route.ts');
const req=(path,method='GET',body,origin='https://app.example')=>new Request('https://app.example/api/admin/'+path,{method,headers:{origin},...(body===undefined?{}:{body:JSON.stringify(body)})});
const ctx={params:Promise.resolve({userId:'b',modelId:'m'})};
beforeEach(()=>{
  Object.assign(actor,{role:'ADMIN',disabled:false});globalThis.day2Session={user:{...actor}};
  process.env.BETTER_AUTH_URL='https://app.example';process.env.AICHAT_LOCAL_SMOKE='0';
  mutations=0;revoked=undefined;quotaLimit=undefined;adminCount=2;calls=[];
});
test('all admin handlers independently enforce 401/403 and no-store',async()=>{
  const handlers=[()=>users(req('users')),()=>PATCH(req('users/b','PATCH',{role:'USER'}),{params:Promise.resolve({id:'b'})}),()=>quotas(req('quotas?userId=b')),()=>PUT(req('quotas/b/m','PUT',{dailyLimit:0}),ctx),()=>DELETE(req('quotas/b/m','DELETE'),ctx),()=>usage(req('usage?from=2026-09-01&to=2026-09-02'))];
  for(const run of handlers){
    globalThis.day2Session=null;let response=await run();assert.equal(response.status,401);assert.equal(response.headers.get('Cache-Control'),'no-store');
    globalThis.day2Session={user:{...actor,role:'USER'}};assert.equal((await run()).status,403);
    globalThis.day2Session={user:{...actor,role:'ADMIN'}};actor.disabled=true;assert.equal((await run()).status,403);actor.disabled=false;
  }
});
test('admin writes reject invalid origins before mutations',async()=>{
  for(const origin of ['','null','https://evil.example','https://app.example/path']) assert.equal((await PUT(req('quotas/b/m','PUT',{dailyLimit:0},origin),ctx)).status,403);
  assert.equal(quotaLimit,undefined);assert.equal(calls.length,0);
});
test('last administrator and self-demotion return 409; successful changes revoke sessions',async()=>{
  assert.equal((await PATCH(req('users/a','PATCH',{disabled:true}),{params:Promise.resolve({id:'a'})})).status,409);
  adminCount=1;
  const last=await PATCH(req('users/b','PATCH',{role:'USER'}),{params:Promise.resolve({id:'b'})});
  assert.equal(last.status,409);assert.deepEqual(await last.json(),{error:'LAST_ADMIN'});assert.equal(mutations,0);
  adminCount=2;assert.equal((await PATCH(req('users/b','PATCH',{role:'USER'}),{params:Promise.resolve({id:'b'})})).status,200);
  assert.equal(revoked,'b');assert.ok(calls.some(([sql])=>sql.includes('FOR UPDATE')));
});
test('quotas include defaults, allow zero, reject malformed values, delete restores default',async()=>{
  assert.deepEqual((await (await quotas(req('quotas?userId=b'))).json()).items,[{modelId:'m',dailyLimit:0,effectiveLimit:0,source:'override'},{modelId:'n',dailyLimit:null,effectiveLimit:200000,source:'default'}]);
  for(const dailyLimit of [-1,1.5,2147483648,'1']) assert.equal((await PUT(req('quotas/b/m','PUT',{dailyLimit}),ctx)).status,400);
  assert.equal((await PUT(req('quotas/b/m','PUT',{dailyLimit:0}),ctx)).status,200);assert.equal(quotaLimit,0);
  assert.equal((await DELETE(req('quotas/b/m','DELETE'),ctx)).status,204);assert.equal(quotaLimit,null);
});
test('usage validates UTC dates and maximum range, uses parameterized half-open SQL and string tokens',async()=>{
  for(const query of ['from=2026-02-30&to=2026-03-01','from=2026-09-01&to=2026-10-03','from=2026-09-01&to=2026-09-01']) assert.equal((await usage(req('usage?'+query))).status,400);
  const response=await usage(req('usage?from=2026-09-01&to=2026-10-02&userId=a'));
  assert.equal((await response.json()).rows[0].tokens,'4294967294');
  const [sql,values]=calls.at(-1);assert.ok(sql.includes('date >= ?::date AND date < ?::date'));assert.equal(values[2],'a');assert.ok(!sql.includes('reservedTokens'));
});
