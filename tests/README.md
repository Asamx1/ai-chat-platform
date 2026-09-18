# M1 冒烟测试（repo/tests/）

针对 M1 登录链路的两个 HTTP 冒烟脚本。纯 Node（v24，PATH 自带）+ 原生 `fetch`，零依赖、不安装任何包。

## 文件

| 脚本 | 用途 |
| --- | --- |
| `smoke-login.mjs` | 登录冒烟：seed 管理员账号登录 → 拿 session cookie 调 get-session 验证身份 → 错误密码必须被拒 |
| `smoke-db.mjs` | 可用性冒烟（run_only_if：dev server 必须已启动）：auth 路由活着（无效账号非 200）+ `/api/health` 200 + 首页 HTML 含项目标识 |

## 前置条件

1. **基础设施**：docker compose 三容器已起（postgres 容器名 `aichat-postgres`，端口 5432）。
   `DATABASE_URL=postgresql://aichat:change-me-local-only@localhost:5432/aichat`
2. **数据库**：Prisma migrate 已应用 + seed 已执行（存在 `admin@example.com` / `admin12345` 管理员账号）。
3. **Web 服务**：在 `repo/` 下 `pnpm dev`，默认 `http://localhost:3000`。

## 用法

```bash
cd repo/tests

# 登录冒烟（默认账号 admin@example.com / admin12345）
node smoke-login.mjs

# 可用性冒烟
node smoke-db.mjs
```

两个脚本成功时输出 `all assertions passed` 并以退出码 0 结束；任一断言失败输出 FAIL 明细并退出码 1，可直接接 CI。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_BASE_URL` | `http://localhost:3000` | web dev server 地址 |
| `SEED_ADMIN_EMAIL` | `admin@example.com` | seed 的管理员邮箱 |
| `SEED_ADMIN_PASSWORD` | `admin12345` | seed 的管理员密码 |

示例：

```bash
WEB_BASE_URL=http://localhost:3001 SEED_ADMIN_EMAIL=ops@example.com node smoke-login.mjs
```

## 断言点明细

**smoke-login.mjs**
1. `POST {BASE}/api/auth/sign-in/email`（seed 账号）→ 断言 200，且响应体含 `session`（含 `token` 或 `id` 字段，符合 better-auth 返回结构）。
2. 用登录响应的 Set-Cookie 调 `GET {BASE}/api/auth/get-session` → 断言 200，且 `user.email` 与入参邮箱一致。
3. 错误密码登录 → 断言非 200（better-auth 预期返回 401）。

**smoke-db.mjs**（run_only_if：dev server 已启动）
1. `POST {BASE}/api/auth/sign-in/email`（不存在账号）→ 断言非 200，验证 auth 路由活着。
2. `GET {BASE}/api/health` → 断言 200。
3. `GET {BASE}/` → 断言 200，且 HTML 含 `ai-chat-platform` 或 `M1`（不区分大小写）。

## 说明

- 不直连数据库、不用 prisma client、不走 `docker exec psql`（跨平台问题），DB 层状态通过上述 HTTP 断言间接覆盖。
- 脚本只读不写，不会创建/修改任何服务端数据（登录产生的 session 属正常副作用）。
