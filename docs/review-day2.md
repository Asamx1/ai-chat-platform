# Day2 安全审查（273d582..HEAD）

范围：/api/admin/* 五路由、lib/admin.ts、same-origin.ts、quota.ts/quota-provider.ts、resolver、/admin 前端、keys Origin 校验、usage 聚合。

## 严重
无。

## 中等
1. **配额预占泄漏（永久占用）** `packages/providers/src/quota-provider.ts:349-359`：provider 流开始后若进程崩溃/重启，reservation 永远停留 `reserved`，`reservedTokens` 不再释放，当日剩余额度被永久扣减，且重试时 `QUOTA_OUTCOME_UNKNOWN` 阻塞该 invocation。设计上明确"未知不退"，但缺少任何超时回收/日切清理机制（次日 usageDate 换行仅部分缓解）。最小修复：增加启动/定时任务将超过 N 小时的 `reserved` 且 `endedAt IS NULL` 的 ProviderCall 标记 `released` 并归还 reservedTokens。

## 轻微
1. **自降级判定不含 role 变更无操作场景** `apps/web/src/app/api/admin/users/[id]/route.ts:60-67`：任何 PATCH（即使 body 与现值相同）都会 `deleteMany` 目标用户全部 session（:67），造成无谓的强制下线；管理员改自己 role=ADMIN 也会踢掉自己会话。最小修复：比对更新前后值，无变化时跳过 update 与 session 删除（disabled 生效场景仍删）。
2. **末位管理员保护边界** 同文件 :61：仅当目标是「未禁用的 ADMIN」才检查 LAST_ADMIN。将唯一 ADMIN 先 disabled 再降级需两步，第二步时 count(enabled ADMIN)=0 已无其他管理员可操作，路径自洽；但「禁用唯一管理员」一步即可达成与降级等同的效果（:61 对 disabled=true 也做了 count<=1 检查，已覆盖）。结论：保护有效，通过；仅建议注释说明 disabled 与降级共用同一检查。
3. **Origin 校验只对比 baseURL，不含 trustedOrigins** `apps/web/src/lib/same-origin.ts:35`：本地开发下 `http://127.0.0.1:3000` 发起的请求在 baseURL=`http://localhost:3000` 时被拒（可用性问题，非绕过）。缺 Origin / `Origin: null` / 端口不匹配均正确拒绝（:32 字符串全等比较含端口）。GET 路由未校验 Origin，但均为只读且响应无法跨域读取，CSRF 无收益。通过，建议 trustedOrigins 一并纳入比对以改善开发体验。
4. **reservation 金额校验失败与超限不可区分** `packages/providers/src/quota.ts:240,255`：`bound!+maxTokens` 超过 2147483647 时返回 null，被调用方当作 QUOTA_EXCEEDED 降级到本地模型（quota-provider.ts:332-336），属可接受的保守行为，建议日志区分。
5. **usage 时间参数上界语义** `apps/web/src/app/api/admin/usage/route.ts:115,122`：`to` 为排他边界且校验用 `to<=from`，"to" 当天数据不包含，前端展示需对齐；SQL 全部经 Prisma tagged template 参数化（:120-125），userId/modelId 先做存在性校验（:118-119），无注入面。通过。

## 逐项结论
1. **权限提升面**：PATCH 严格白名单 role/disabled（:47-49），非管理员无法触达（requireAdmin 双判），自降级被 409 拦截，末位管理员保护在 advisory lock 72819201 + `FOR UPDATE` 串行化下无竞态绕过；disabled/角色变更后 `deleteMany` session 即时失效，且 requireAdmin 每次回查 DB `disabled`。通过。
2. **requireAdmin 双重判定** `lib/admin.ts:16`：DB role 与 session role 需同时为 ADMIN，disabled 即拒；无绕路。GET 未做 Origin 校验见轻微#3。通过。
3. **配额锁/预占**：amount 非负整数且 ≤ int32 上限（quota.ts:240）；`lockQuota`（hashtextextended advisory xact lock）+ 逐行 `FOR UPDATE` 串行化同 (userId,modelId) 预占，超支检查在锁内（:250-255），并发不会超支；负数 reservedTokens 不可能（finishQuota 状态机 :277 幂等）。残留问题见中等#1。通过（附条件）。
4. **Origin 校验**：实现正确，无缺头/null/端口绕过。通过（轻微#3）。
5. **usage 聚合 SQL**：参数化 + 输入校验，`tokensIn::bigint` 先转型避免 int 溢出。通过。

前端 /admin（UserTable/QuotaEditor/UsageView/api.ts）仅调用上述 API，未发现额外面。
