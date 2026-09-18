以下为交付正文（纯文本 markdown，约1500字）：

# M1（单聊纵切）测试计划

## 一、测试范围与优先级矩阵

范围：M1 单聊纵切的四项验收标准及其支撑链路（Next.js 16.3 API/tRPC 层、SSE 通道、Prisma7/PostgreSQL 持久化、BetterAuth 会话鉴权）。不含：多人群聊、多模型编排、移动端、生产反代配置。

优先级矩阵：
- P0：验收①并发不串流；验收②断线重连事件不重不丢；验收③跨用户越权全 404；验收④lint/typecheck/test/build 门禁。
- P1：Last-Event-ID 回放边界（首连无该头、lastId 越界、事件已过期）；事件序号单调性；token 过期后重连的 401 处理。
- P2：event_log 膨胀与慢客户端背压；同账号多标签；Firefox/WebKit 抽测。

## 二、验收用例设计（前置/步骤/断言/自动化程度）

TC-01 并发不串流（全自动，Playwright）
- 前置：用户 A/B 各持有效会话与空对话；SSE 可达。
- 步骤：A、B 同一时刻各发短消息，收流至 done，循环 100 轮。
- 断言：每条流的事件 payload.conversationId 等于本会话 id；token 文本不含对方特征串；DB 中 message 的 userId/conversationId 归属正确；双方序号各自连续。

TC-02 随机断连重连（全自动，Playwright+vitest）
- 前置：长回答场景（服务端应发事件数 N≥200）。
- 步骤：流式进行中随机断网 5–30s，恢复后凭 Last-Event-ID 自动重连，共 100 次。
- 断言：客户端收到的事件 id 集合与 event_log 中 [1..maxSeq] 完全相等——重复数=计数-set大小=0；丢失=期望集合-收到集合=∅。

TC-03 跨用户 404（全自动，vitest API 层）
- 前置：A 的对话已存在若干事件。
- 步骤：B 携自身凭证访问 A 的读（GET /conversations/:id 或 trpc conversation.byId）、订阅（GET /:id/stream）、取消（POST /:id/cancel）、回放（GET /:id/replay?after=）。
- 断言：四类接口全部返回 404（tRPC 为 NOT_FOUND），而非 403/401，防止存在性泄露；响应体不含 A 的任何字段；服务端不产生副作用（订阅未建立、取消未生效）。

TC-04 质量门禁（全自动，CI）：pnpm lint、tsc --noEmit、vitest run、next build 依次执行，退出码全 0；任一失败即阻断合并。

## 三、断线重连技术方案

断连模拟：Playwright 侧用 CDP session 执行 Network.emulateNetworkConditions(offline:true)（等价 context.setOffline(true)），sleep 随机 5000–30000ms（可注入固定 seed 的 RNG 保证可复现）后恢复；vitest 侧 mock fetch/EventSource 按概率抛错模拟传输层中断。两种断法各 50 次，覆盖浏览器级与传输级。

精确统计：协议强制每事件携带会话内单调递增整数 id，服务端发送即落 event_log 表（conversationId、seq、payload，seq 由 DB 原子自增，避免并发取号冲突）。重连时读取 Last-Event-ID，先回放 seq>lastId 的落库事件再切换实时流，实现"至少一次投递+客户端按 id 去重"。断言时以 event_log 为唯一事实源，与客户端 receivedIds 做集合比对，杜绝靠日志肉眼判断。

## 四、串流污染测试方案

构造：两个 Playwright browser context 分别注入 A/B 的 BetterAuth session cookie；Promise.all 对齐同一毫秒触发发送；为放大路由错误概率，双方使用同模型、同参数、同长度提示词（如"重复输出字符X共50次"，A 用 X、B 用 Y 作特征串）。

断言：①各 context 收到的 SSE data 中 conversationId 恒等于本会话；②累计 token 文本不含对方特征串（X/Y 交叉检测）；③event_log 无归属错误的行；④中途取消 A 的流，B 的流不受影响仍完整收完；⑤服务端日志无会话上下文混用告警。

## 五、测试数据与清理策略

- 所有造数带唯一 runId（nanoid）前缀，用例间互不干扰、可按前缀审计残留。
- vitest 集成层：每 worker 独立 database（或 schema），beforeAll 迁移、afterAll drop；单测用事务回滚。
- Playwright e2e：专用 e2e 库+seed 脚本；afterAll 按 runId 批量删除 conversation/message/event_log/用户，并断言残留计数为 0。
- 密钥走 .env.test，不入库不入仓；BetterAuth 用户由 seed 脚本创建，测试后连级联数据一并清除。

## 六、风险与未覆盖面

- 随机断连用例有偶发性：必须固定 seed 可复现，失败时自动保存 Playwright trace 与服务端日志片段。
- SSE 经 Nginx/Cloudflare 的缓冲、超时、压缩行为未覆盖，M1 仅测直连，建议 M2 补。
- LLM 上游不稳定导致的长流中断补偿、背压与限流属未覆盖面。
- 100 轮×并发的 e2e 耗时较长：PR 流水线抽测 20 次，夜间全量 100 次。
- 事件过期窗口（event_log 保留期）与 lastId 越界的交互逻辑需开发确认后再定 P1 断言细节。

---

报告
- result：上方 markdown 正文（约 1500 字，落在 1200–1800 区间），覆盖六个要求章节与四项验收标准。
- changed files：无（按要求直接输出全文，未做任何文件改动）。
- checks actually run：无工具调用；本文为规划交付，依据任务提供的验收标准与技术栈编写，未读取项目仓库，未执行任何 lint/test/build。
- remaining issues：①tRPC 与 REST 未最终选型，TC-03 的 404 语义（HTTP 404 vs tRPC NOT_FOUND）需按选型收敛；②event_log 保留期与回放越界行为待开发确认；③反代环境下的 SSE 行为明确排除在 M1 之外。
