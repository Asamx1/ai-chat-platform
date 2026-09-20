/**
 * Production login-page browser smoke test.
 *
 * Preconditions:
 *   - a production web server is listening at WEB_BASE_URL (default :3100)
 *   - the seeded admin account exists
 */
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

const BASE_URL = new URL(process.env.WEB_BASE_URL || 'http://127.0.0.1:3100');
const APP_ORIGIN = BASE_URL.origin;
const EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin12345';
const EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

function assert(label, condition, detail = '') {
  if (!condition) {
    throw new Error(`${label}${detail ? ` (${detail})` : ''}`);
  }
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function waitForPath(page, pathname) {
  await page.waitForFunction(
    (expected) => window.location.pathname === expected,
    { timeout: 15_000 },
    pathname,
  );
}

(async () => {
  const executablePath = EXECUTABLE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  assert('browser executable discovered', Boolean(executablePath));

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox'],
  });
  let context;
  let page;

  try {
    context = await browser.createBrowserContext();
    page = await context.newPage();
    const sameOriginResponses = [];

    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === APP_ORIGIN && (url.pathname === '/' || url.pathname === '/login' || url.pathname.startsWith('/api/'))) {
        sameOriginResponses.push({ method: response.request().method(), path: url.pathname, status: response.status() });
      }
    });

    await page.goto(new URL('/', APP_ORIGIN).href, { waitUntil: 'networkidle2', timeout: 30_000 });
    assert('anonymous home redirects to /login', new URL(page.url()).pathname === '/login', `path=${new URL(page.url()).pathname}`);

    const emailInput = await page.$('input[type="email"][name="email"]');
    const passwordInput = await page.$('input[type="password"][name="password"]');
    const submitButton = await page.$('form button[type="submit"]');
    assert('semantic email field exists', Boolean(emailInput));
    assert('semantic password field exists', Boolean(passwordInput));
    assert('semantic submit button exists', Boolean(submitButton));

    const anonymousStatus = await page.evaluate(async () => {
      const response = await fetch('/api/conversations', { credentials: 'include' });
      return response.status;
    });
    assert('anonymous conversations request returns 401', anonymousStatus === 401, `status=${anonymousStatus}`);

    await emailInput.type(EMAIL);
    await passwordInput.type(PASSWORD);
    await submitButton.click();
    await waitForPath(page, '/');
    await page.waitForSelector('.app-shell', { timeout: 15_000 });

    const pageText = await page.evaluate(() => document.body.innerText);
    assert('chat UI is visible after login', /新对话|会话|对话/.test(pageText));
    assert('authenticated page does not show HTTP 401', !pageText.includes('HTTP 401'));

    const authenticatedStatus = await page.evaluate(async () => {
      const response = await fetch('/api/conversations', { credentials: 'include' });
      return response.status;
    });
    assert('authenticated conversations request returns 200', authenticatedStatus === 200, `status=${authenticatedStatus}`);

    await page.goto(new URL('/login', APP_ORIGIN).href, { waitUntil: 'networkidle2', timeout: 30_000 });
    assert('authenticated /login redirects to /', new URL(page.url()).pathname === '/', `path=${new URL(page.url()).pathname}`);

    assert(
      'captured anonymous conversations 401 response',
      sameOriginResponses.some((entry) => entry.path === '/api/conversations' && entry.status === 401),
    );
    assert(
      'captured authenticated conversations 200 response',
      sameOriginResponses.some((entry) => entry.path === '/api/conversations' && entry.status === 200),
    );
    console.log(`[INFO] captured ${sameOriginResponses.length} same-origin app/API responses`);
    console.log('smoke-login-page: all assertions passed');
  } finally {
    try {
      if (context) await context.close();
    } finally {
      await browser.close();
    }
  }
})().catch((error) => {
  console.error(`smoke-login-page: ${error.message}`);
  process.exit(1);
});
