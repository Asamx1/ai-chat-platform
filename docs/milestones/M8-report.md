# M8 里程碑报告 — 加固交付

日期：2026-09-26 · 状态：**完成（v1.0-rc）**

## 交付物（PLAN §12-M8 对照）

| 任务 | 实现 | 证据 |
|---|---|---|
| 全量测试/审计 | 24 套件 126 用例全绿；audit 57 findings 全在 dev-peer 链（critical=vitest peer，high 11=dev 工具），生产运行时干净 | 本报告附 DoD 表 |
| 部署/备份/恢复/故障文档 | README 冷启动 6 步 + 演示脚本 + backup/restore 用法；ops 手册（m1-ops-manual） | README.md |
| 备份恢复演练 | backup.ps1（docker cp 二进制安全）→ restore.ps1（恢复到验证库）→ **6/6 表计数核验一致 + smoke 应答** | E:\ai-chat-data\backups\*.manifest.json |
| 敏感信息扫描 | .env gitignore；密钥仅密文字段（passwordHash/ciphertext）；日志无 Authorization/密钥（M0 安全审查+codex 复核） | git log 安全 commit |

## Definition of Done 终检（PLAN §17 逐项）

| # | DoD 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | v1.0 必须范围量化验收 | ✅ | M1-M7 报告逐出口对照（SSE 100 轮 0 丢重/kill 恢复/20 并发无 OOM/三模式真实模型） |
| 2 | prisma format/validate/migrate/关系测试 | ✅ | validate 🚀 + 6 迁移全 applied + db-relations 集成测试 |
| 3 | durable run DB/Redis/worker 故障恢复 | ✅ | fault-matrix 5 阶段注入 + replay-cold（Redis FLUSHALL 327 事件回放） |
| 4 | 三协作模式 fake+真实模型 | ✅ | GROUP/CONSENSUS（M3 e2e）+ DEBATE（M4 异构辩论 e2e，8b vs 7b） |
| 5 | GPU 调度无 OOM + 性能基线 | ✅ | stress-20（p50=496ms claim）+ ollama-bench 四模型基线 |
| 6 | run 可回放可导出 | ✅ | export API（configHash）+ 冷启动回放 |
| 7 | 安全测试无越权/SSRF/明文密钥 | ✅ | 跨用户 404 套件 + codex HIGH 泄漏修复（M0）+ SSRF 校验 |
| 8 | 实验等预算对照+消融+统计+失败分析 | ✅ | exp1/exp2 864 runs + Wilson/McNemar + 局限如实报告 |
| 9 | README/ADR/协议/部署/备份文档 | ✅ | README + 3 ADR + protocol-v1 + 本报告 |
| 10 | CI 门禁全绿 | ✅ | 全仓 14 + web 5 + worker 5 = 24 套件 126 用例 + build 10 路由（本地 CI 等价） |
| 11 | 答辩演示（单聊/协作/排队/停止/恢复/回放/实验） | ✅ | README 演示路径 5 分钟脚本 |

## 工程坑留档（STATE 新增）

PowerShell 管道重编码损坏 pg_dump 数据 / psql 传参引号剥离 / .ps1 中文 BOM / tsx 缓存旧代码 / zod4 record 两参 / chai every 不存在 / next 端口孤儿进程

## 版本

`git tag v1.0-rc`（49 commits，M0→M8 全里程碑，进度超前原计划约 5 周）
