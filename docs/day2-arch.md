# Day2 架构方案

## 1. schema 变更与迁移
`packages/db/prisma/schema.prisma` 新增 UserModelQuota：id（cuid 主键）、userId、modelId、dailyLimit（Int），`@@unique([userId,modelId])`；关联 User/ModelRegistry，级联删除并补反向关系。SQL CHECK 限额≥0；无记录回落 DAILY_CLOUD_TOKEN_LIMIT=200000，0 禁止云调用。

User 增加 disabled Boolean 默认 false。为调用前预占，ModelUsageDaily 增加 reservedTokens Int 默认0；ProviderCall 增加 quotaReservation Json?，保存 modelId、UTC日期、数量、状态。新增迁移，不改历史迁移；先迁移、生成客户端再部署。历史 modelKey 用 provider+modelKey 映射 registry id 并合并日用量；歧义记录阻止迁移，禁止猜配。回滚先停新调用、清算预占再回退应用，保留数据列。

## 2. /api/admin/* 契约
统一 requireAdmin：无会话401；禁用或 `session.user.role !== 'ADMIN'` 返回403。写操作同源校验。错误 `{error:code}`；非法参数400、不存在404、冲突409；响应禁缓存，不返回密码/密钥。

|方法、路径（前缀 /api/admin）|输入→输出|
|---|---|
|GET /users|cursor、limit默认20最大100、q → users[id,email,role,disabled]、nextCursor；按id排序|
|PATCH /users/[id]|{disabled?:boolean,role?:ADMIN\|USER}，至少一项 → user|
|GET /quotas?userId=|→ items[modelId,dailyLimit,effectiveLimit,source]，包含无覆盖模型|
|PUT /quotas/[userId]/[modelId]|{dailyLimit:整数0..2147483647} → quota；upsert|
|DELETE 同上|删除覆盖→204，恢复默认|
|GET /usage|from/to UTC日期、可选userId/modelId；最多31天 → rows[date,userId,modelId,tokens]|

PATCH 在事务内锁定 ADMIN 用户行，防止删除最后一位有效管理员；禁止自禁用/自降级，变更后删除目标全部 Session。配额写入与预占使用同一用户/模型锁；降低限额不撤销在途调用。usage 使用参数化 SQL，区间左闭右开，tokens 序列化为十进制字符串；日表统计含本地模型，不把预占当消费：

```sql
SELECT date,"userId","modelId",
 SUM("tokensIn"::bigint+"tokensOut") AS tokens
FROM "ModelUsageDaily"
WHERE date >= $1::date AND date < $2::date
 AND ($3::text IS NULL OR "userId"=$3)
 AND ($4::text IS NULL OR "modelId"=$4)
GROUP BY date,"userId","modelId"
ORDER BY date,"userId","modelId";
```

## 3. resolver 配额与 TOCTOU
现状 resolver 用 `>` 比较常量；inline/worker 在调用结束才累计。扩展 ResolverStore，在云模型、密钥确认后按规范化 row.id 读取覆盖；达到上限即降级，沿用 QUOTA_EXCEEDED/NO_LOCAL_MODEL。

选择增量前移：执行前短事务 upsert 日行、FOR UPDATE、重读限额与已用/预占，再按 requestHash 创建 ProviderCall 并增加 reservedTokens；失败则本地回退。预占量=完整请求输入保守上界+强制最大输出量；适配器必须提供上界并传输出限制，不支持则回退，不能凭平均值放行。网络请求在事务外；请求入队时的 resolve 仅预检。

结算事务按日行→call固定顺序锁定，释放预占、增加实际tokens、写 UsageLog、标记settled；移除现有重复增量。重放只结算一次，使用预占时UTC日；替补模型重新预占。明确未发送的失败可释放；超时/崩溃且结果未知保留预占，恢复任务核实后结算，禁止超时直接退款或重发。inline、普通worker、collab共用此入口。

## 4. 进度视图
RunTimeline 保留详情/导出，拆出 useRunProgress、StageBar、ParticipantCard、UsageSummary，reducer按seq去重，卡片按seatId归并。

现有 collab.ts 在策略结束后才 yield；改异步队列即时输出，补 stage.changed{stage,round}，阶段取 PLANNING/ROUND/JUDGING/SYNTHESIZING；同步扩展 contracts。阶段事件驱动阶段条，不能按时间猜百分比。seat.started/completed 对应运行/完成；degraded 标记异常，seat.substituted 用实际 from/to（兼容fromSeatId/toSeatId）；run.succeeded/cancelled 收尾。run.failed 可能重试，等待 stream.end；终态事件缺失时显示“已结束、详情缺失”。

首次 JSON 回放后 SSE 从 after=maxSeq 订阅；保留Last-Event-ID语义，断线退避1/2/5/10秒，持续失败改2秒增量JSON轮询（响应补run.status），恢复后停轮询；卸载/终态关闭连接。服务器现有2秒轮询、15秒心跳保留。usage事件仅触发刷新，/usage返回的seats/totals覆盖显示，不能叠加；每5秒及终态刷新，失败标记旧值，未知token不写0，保留(unassigned)。

## 5. /admin 页面与门禁
服务端layout调用requireAdmin，未登录跳登录页，非ADMIN拒绝；API独立鉴权。页面含用户表、角色/禁用确认框、用户模型限额编辑、日期用量表；提供加载、空态、错误及保存反馈。auth.ts增加disabled只读附加字段；登录拒绝禁用用户，会话读取检查数据库禁用状态，角色修改撤销会话，不能仅隐藏菜单。

## 6. 文件清单与测试计划
施工范围：上述schema/新迁移；providers的resolver及共享配额模块；web的lib/auth、admin鉴权、chat-service；worker的runner/collab-runner；orchestrator/collab、contracts/events；web的api/admin/**、admin/**、components/runs/**及events路由。

backlog：api/keys/route.ts的POST/DELETE在外部请求前校验Origin等于配置的应用origin，缺失/null/非法值拒绝403。tests新增共享浏览器定位器，smoke-login-page、ui-m3-verify、ui-m5-smoke依次查PUPPETEER_EXECUTABLE_PATH、CHROME_PATH、系统候选；无可执行文件明确失败；截图用E2E_ARTIFACT_DIR或仓库临时目录。根package.json的typecheck设为 `node scripts/typecheck.mjs`：枚举apps/packages的tsconfig，解析web现有TypeScript，逐包运行 `tsc -p <配置> --noEmit --incremental false`，透传失败码；lint设为 `pnpm typecheck`，注明仅类型检查并替换web的next lint；不假设已有项目引用。

实施测试：迁移保留历史/歧义阻断；401/403、最后管理员并发保护、旧会话失效；配额默认/0/边界、并发预占、UTC跨日、崩溃/重放/替补；SQL日期边界；首个seat事件须早于调用完成、阶段/重连去重/终态/usage失败；keys跨源不触发外部请求；Windows/Linux候选与截图路径；注入类型错误须使根脚本失败。运行相关Vitest、数据库集成与浏览器E2E并留证。本次仅交付方案，以上测试待实施。
