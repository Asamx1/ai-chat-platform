# Login page E2E RED verification

- Time: `2026-09-20T20:40:14.2568662+08:00`
- Historical commit: `3179a885532c950f74ea38950a2763d15c52afab`
- Isolation: detached temporary Git worktree, production build, `http://127.0.0.1:3200`
- Current application on port 3100: not used or restarted

The historical production build was started on port 3200 with the local-smoke auth policy. The current browser smoke was executed against it:

```powershell
$env:WEB_BASE_URL='http://127.0.0.1:3200'
node E:\AI-Workstation\work\ai-chat-platform\repo\tests\smoke-login-page.cjs
```

Observed output:

```text
[PASS] browser executable discovered
smoke-login-page: anonymous home redirects to /login (path=/)
```

The smoke exited with status 1 for the expected behavioral reason: the old build completed browser navigation but left the anonymous user at `/` instead of redirecting to `/login`. This was not an infrastructure failure. The temporary server process tree was stopped afterward and port 3200 was confirmed free.

No credentials, cookies, tokens, or environment values were written to this artifact.

## Login commit scope rationale

Commit `ebd39e965a31cec42c98103c869d4dae7ef39224` moved five database-backed suites from `apps/web/test` to `apps/web/integration-test` and added separate Vitest configurations/scripts. This is necessary login-test infrastructure rather than an unrelated product change:

- The login flow introduced fast unit/component tests that must run without a database.
- The previous web test glob mixed those tests with database-backed suites, making the documented unit command depend on PostgreSQL and `DATABASE_URL`.
- The five moves preserve the test bodies (Git detected them as 97–98% renames) while making the unit/integration boundary explicit.
- `vitest.config.ts`, `vitest.integration.config.ts`, and the package scripts are the wiring that enforces that boundary.

The prior shared commit was not rewritten. Follow-up environment-loading and launcher-test isolation changes are kept in a separate focused commit.
