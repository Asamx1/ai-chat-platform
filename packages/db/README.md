# Database: Vault 表族（P1/M15）

Vault 使用独立的 `vaultId` 根（默认 `default`），与旧 KB 表族互不相干。
不依赖 `kbId`、KnowledgeBase、Document、SourceVersion 或既有实体图；本迁移不修改任何旧表或旧 model。

简报标题写 6 个 model，实际逐项定义 7 个，全部实现：

| Model | 用途 |
| --- | --- |
| VaultSource | 来源登记；同 vault、家族、SHA-256 的重复导入由唯一索引拒绝 |
| VaultSourceFamily | 家族元数据；独立来源门槛按 `count(distinct familyId)` 查询 |
| VaultPage | Wiki 页面投影；同 vault 内 pageId（slug）唯一 |
| VaultAssertion | 结构化断言及可空页面关联 |
| VaultEvidence | 来源定位、引文（最多 500 字符）与支持/反对立场 |
| VaultRelease | 发布批次、文件哈希清单、基线与 Git 提交 |
| VaultEntityCandidate | 候选实体、首次来源、家族与别名数组 |

迁移：`prisma/migrations/20260925000000_vault_tables/migration.sql`，为手写 SQL。
参考 `20260924010000_entity_graph` 的双引号表名、TEXT 主键、TIMESTAMP(3)、
CURRENT_TIMESTAMP、JSONB 以及 `<表>_<列>_key/idx` 索引命名。
参考迁移实际使用 camelCase 列名；新增表按本次硬性要求使用 `@map` 映射到 snake_case，
SQL 与映射后的列名一致，不改旧表命名。所有已声明外键均 ON DELETE/UPDATE CASCADE。
`cuid()` 与 `@updatedAt` 由 Prisma 客户端处理，因此 SQL 不为 id、updated_at 添加数据库默认值。

VaultSource.familyId 指向 VaultSourceFamily.id；断言的 pageId 是页面 slug，
通过 `(vaultId, pageId)` 关联 VaultPage。证据关联断言和来源，候选实体关联首次来源。
`promotedPageId` 按简报保留为可空字符串。

字符串枚举、rev-NNN、asr_ 前缀、JSON 内容结构、同 vault 的来源/家族一致性
由应用层校验。为支持简报的“实体 objectId / 字面值 value 二选一”，两列均可空，
应用层必须保证恰好一列有值；数据库没有额外 CHECK 约束。
SHA-256 列使用 VARCHAR(64)，精确的 64 位十六进制格式由应用层校验。
`addedBy` 默认 user，应用层写入该字面量。

类型从 `src/index.ts` 导出。此任务不运行 migrate/generate 或构建；
客户端生成、迁移执行与完整验收由编排方进行。
