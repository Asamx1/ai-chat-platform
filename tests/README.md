# Smoke and end-to-end tests

These scripts verify the running web application over HTTP. They are opt-in and are not invoked by `pnpm test` or `pnpm test:integration`.

## Commands

Run the production login-page browser contract:

```powershell
pnpm test:e2e
```

`test:e2e` runs `tests/smoke-login-page.cjs` with the installed `puppeteer-core` package and a locally installed Edge or Chrome executable. It does not start, build, migrate, or seed the application.

Run the API login smoke independently:

```powershell
$env:WEB_BASE_URL='http://127.0.0.1:3100'
node tests/smoke-login.mjs
```

## `test:e2e` preconditions

1. A production web server is already listening at `WEB_BASE_URL` (default `http://127.0.0.1:3100`).
2. PostgreSQL migrations and seed data have been applied.
3. The seed administrator account exists.
4. Edge or Chrome is installed, or `PUPPETEER_EXECUTABLE_PATH` identifies a browser executable.

The browser smoke uses a clean browser context and verifies:

- anonymous `/` redirects to `/login`;
- semantic email/password controls are present;
- anonymous `/api/conversations` returns 401;
- form login reaches `/` and renders the chat UI without `HTTP 401` text;
- authenticated `/api/conversations` returns 200;
- authenticated `/login` redirects to `/`;
- the expected same-origin API statuses were observed.

## Environment variables

| Variable | Browser smoke default | API smoke default | Description |
| --- | --- | --- | --- |
| `WEB_BASE_URL` | `http://127.0.0.1:3100` | `http://localhost:3000` | Running web application origin. A trailing slash is accepted. |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | `admin@example.com` | Seed administrator email. |
| `SEED_ADMIN_PASSWORD` | `admin12345` | `admin12345` | Seed administrator password. |
| `PUPPETEER_EXECUTABLE_PATH` | auto-discovered | n/a | Optional Edge/Chrome executable override. |

Neither smoke prints credentials, cookies, session tokens, or response bodies containing them. Login creates a normal server-side session as an expected side effect.
