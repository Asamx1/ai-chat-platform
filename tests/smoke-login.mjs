// M1 login smoke test for ai-chat-platform.
// Usage: node tests/smoke-login.mjs
// Env:
//   WEB_BASE_URL        default http://localhost:3000
//   SEED_ADMIN_EMAIL    default admin@example.com
//   SEED_ADMIN_PASSWORD default admin12345
// Preconditions: docker compose services up (postgres), pnpm dev running, seed executed.

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin12345';

let failures = 0;

function check(label, cond, detail = '') {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures += 1;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function signIn(email, password) {
  const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookie
    .map((c) => c.split(';')[0])
    .join('; ');
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, cookie, body };
}

async function main() {
  console.log(`smoke-login: BASE=${BASE} EMAIL=${EMAIL}`);

  // 1. Sign in with seeded admin credentials -> expect 200 + session data
  const ok = await signIn(EMAIL, PASSWORD);
  check('sign-in/email returns 200', ok.res.status === 200, `status=${ok.res.status}`);
  // better-auth 1.7 返回扁平结构：{ redirect, token, user }
  const token = ok.body && ok.body.token;
  check(
    'sign-in response contains token',
    typeof token === 'string' && token.length > 0,
    `token present=${Boolean(token)}`
  );
  if (ok.res.status !== 200 || !token) {
    console.error('Aborting: cannot continue without a session.', JSON.stringify(ok.body));
    process.exit(1);
  }

  // 2. Use the session cookie to call get-session -> expect 200 + matching email
  const me = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { cookie: ok.cookie },
  });
  check('get-session returns 200', me.status === 200, `status=${me.status}`);
  const meBody = await me.json().catch(() => null);
  const meEmail = meBody && meBody.user && meBody.user.email;
  check(
    'get-session user.email matches seed account',
    meEmail === EMAIL,
    `got=${meEmail} want=${EMAIL}`
  );

  // 3. Wrong password -> expect non-200 (better-auth returns 401)
  const bad = await signIn(EMAIL, `${PASSWORD}-wrong`);
  check('wrong password is rejected (non-200)', bad.res.status !== 200, `status=${bad.res.status}`);

  if (failures > 0) {
    console.error(`smoke-login: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('smoke-login: all assertions passed');
}

main().catch((err) => {
  console.error('smoke-login: unexpected error —', err && err.message ? err.message : err);
  process.exit(1);
});
