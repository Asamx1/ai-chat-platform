const { browserExecutable, artifactDir } = require('./browser-paths.cjs');
/**
 * M3 UI 浏览器细验 v2：放宽断言（文本匹配代替脆弱选择器）。
 */
const puppeteer = require('puppeteer-core');
const EDGE = browserExecutable();
const BASE = 'http://127.0.0.1:3100';
const SHOT = require('node:path').join(artifactDir(), 'ui-m3');

const ok = (name, cond) => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
  if (!cond) process.exitCode = 1;
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const console_ = [];
  page.on('console', (m) => console_.push(m.text()));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(async () => {
    await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: location.origin },
      body: JSON.stringify({ email: 'admin@example.com', password: 'admin12345' }),
    });
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2000));

  const text = await page.evaluate(() => document.body.innerText);
  ok('home renders with conversation sidebar', /新对话|UI细验|会话|对话/.test(text));
  await page.screenshot({ path: SHOT + '-home.png' });

  // 先选中会话：点「新对话」建一个并激活
  const created = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => (x.textContent || '').includes('新建') || (x.textContent || '').includes('新对话'));
    if (!b) return false;
    b.click();
    return true;
  });
  ok('create-conversation clicked', created);
  console.log('[DEBUG] all buttons:', await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').slice(0,14))));
  await new Promise((r) => setTimeout(r, 1500));

  // 打开协作面板（此时 conversationId 已激活）
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => (x.textContent || '').includes('协作') || /collab/i.test(x.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  ok('collab button found & clicked', clicked);
  await new Promise((r) => setTimeout(r, 800));
  const panelText = await page.evaluate(() => document.body.innerText);
  console.log('[DEBUG] panel text:', JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 300)));
  ok('seat editor visible', /GROUP|CONSENSUS|席位|模型/.test(panelText));
  const debateDisabled = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button,label,[role=radio],input'));
    return els.some((e) => /DEBATE/i.test(e.textContent || '') && (e.disabled || e.getAttribute('aria-disabled') === 'true'));
  });
  console.log(`[INFO] DEBATE 置灰: ${debateDisabled}`);
  await page.screenshot({ path: SHOT + '-panel.png' });

  console.log('[DEBUG] console msgs:', JSON.stringify(console_.slice(0, 5)));
  const errors = console_.filter((t) => /error|uncaught/i.test(t) && !/WebSocket|hmr/i.test(t));
  ok('no console errors', errors.length === 0);

  await browser.close();
  console.log('UI VERIFY v2 DONE');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
