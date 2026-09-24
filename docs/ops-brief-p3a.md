# P3/M17 任务①:WikiJob 状态机 + raw 监听补扫 + Lint 检查框架

【自动化模式】不要中途提问、不要读 skill、不要浏览器操作;全部做完再退出。自由用文件工具读源码;禁跑构建命令(pnpm/npx/prisma/tsc/vitest/node),写完即止,验收由编排方本地实测。

## 背景

P2 已交付严格问答(64.4→67.8%,rev-004)。P3 按方案 §5.3/§10:监听补扫、定期 Lint、冲突/版本/撤回传播、可恢复任务。本任务只做基础设施:任务状态机+补扫+Lint 检查器;OCR/多模态是后续任务。

## 交付物

1. **Prisma WikiJob 表**(packages/db/prisma/schema.prisma + 迁移):
   - id(cuid)、kind(scan_backlog|lint_check|reextract|republish)、status(pending|running|done|failed|cancelled)、attempts/int(max 3)、payload Json、result Json、error String?、vaultId、createdAt/startedAt/finishedAt(@map snake_case,风格与 VaultSource 一致)
2. **packages/wiki/src/jobs.ts**:
   - :原子认领(UPDATE ... WHERE status='pending' ... RETURNING 语义用事务实现),置 running+attempts+1
   -  / :attempts<3 回 pending(退避用 payload.delayUntil 字段记录),否则 failed
   - :同 kind+同 payload 指纹(payload JSON 的 sha256)去重
3. **scan-backlog.mts CLI**(packages/wiki/scripts/):遍历 raw/ 目录 → 与 VaultSource(按 sha256)diff → 新文件入 scan_backlog job → 逐个执行 registerSource+extract(复用 ingest 管线,参考 scripts 里现有 ingest-all 用法)→ 完成打印 registered/extracted 计数。**不自动发布**。
4. **packages/wiki/src/lint.ts** 四类检查(方案 §5.3,只报告不自动修——修复边界留后续任务):
   - :扫描 vault 目录,断链(BROKEN_LINK 语义复用 publish.ts 的 links())、索引遗漏(概念页未列入 index.md)、孤儿概念页(VaultPage 有记录但宿主实体消失——判定语义与 publish.ts publishedPageIds 一致)
   - :无来源断言(断言无 evidence 记录)、回答沉淀页(answers/*.md)被引用为证据
   - :同一 subject+predicate+polarity+conditions 下 value 互斥(字符串不等即报,标注 sourceId 双方)
   - :断言 evidence 的 source.created_at 晚于 assertion 的弃用时间(如有 supersededAt)→ 报「旧信息用于新版本」
   - 统一返回 ; CLI 输出 JSON
5. **测试**(packages/wiki/test/jobs.test.ts、lint.test.ts):用真 PostgreSQL(参考现有测试的 fixture 模式,publish.test.ts 的 mkdtemp+registerSource 造数据法):claimNextJob 并发只有一个赢(两个 await 竞争)、failJob 重试回 pending、第 4 次 failed;lint 四类各至少 1 正 1 反例

## 边界

- 迁移 SQL 只写文件(prisma migrate dev 我来跑);schema.prisma 改完不要跑任何 prisma 命令
- lintTimeliness 若 schema 无 supersededAt 字段:不改既有表,用 payload 侧信息(断言 conditions JSON 里带 superseded 时间戳的)实现并在注释说明
- jobs.ts 事务内不得调 LLM

## 参考文件

packages/wiki/src/publish.ts(links/publishedPageIds 孤儿判定)、scan.ts(registerSource)、scripts/ingest-all.mts、test/publish.test.ts(fixture 模式)

