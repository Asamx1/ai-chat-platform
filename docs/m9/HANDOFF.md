# M9「RAG 质量增强」进度存档(2026-09-23 夜班交接)

> 项目:ai-chat-platform(毕设)· 仓库:WSL `~/code/ai-chat-platform/repo`(main)
> 执行:AI-Workstation(`~/AI-Workstation`,wsl -- bash -lc)· 状态机:new → run → verify → accept --evidence <文件>

## 已完成(全收口)

| # | 任务 | ID | 产出/证据 |
|---|---|---|---|
| grill | 24 决策全确认 | — | docs/m9/00-grill-report.md,commit `21e8c32` |
| S1 | PRD(kimi) | T-…2d989293 | docs/m9/01-prd.md,`75f7923`(从 session 回收) |
| S2 | 架构(codex) | T-…ad6fffa2 | docs/m9/02-arch.md,`7546e9a` |
| S3 | DBA(codex) | T-…10661074 | docs/m9/03-db.md |
| G1 | Jev 门禁 | T-…33a5c3ee | 0.48 有条件放行(条件:G2 须 ≥0.6),docs/m9/gate-1-prd.md,`4768216` |
| S4 | 切割策略注册表(glm) | T-…df0cc480 | strategies/(structure/recursive/fixed/parent-child)+33 用例,`98893d6`;glm 的 scanMarkdown end 未定界 bug 我修的 |
| S5 | 数据层+重切割 API(glm) | T-…7262fc63 | schema 三字段+tsvector GIN+迁移+store small-to-big+rechunk API,`212a395`;真 PG 迁移验证过 |

第二轮 grill(11-agent 分工)决议:**codex 加载为主力,glm 减载(只留审计/测试/报告)**,其余按推荐:env 开关默认开、S9 实验 30 对起步、前端两页(kimi 设计+glm 编码)、夜间省费排程、G2 打回即修后复跑。

## 在途(明日第一件事)

- **S6 混合检索 RRF+MMR+small-to-big — codex,T-20260921-75c83f0a,已重启运行中**(首跑被 WSL 重启杀死,attempts 0 未烧)
- 监听器 proc_8b0e4e60adaf(===S6-DONE===)大概率已随会话失效,直接查:`wsl -- bash -c 'cd ~/AI-Workstation && python3 -c "import json;print(json.load(open(\"tasks/T-20260921-75c83f0a.json\"))[\"status\"])"; tail -5 /tmp/m9_s6run.log'`
- 若 S6 已跑完:回收流程见下;若 run 进程又没了:重跑 `nohup .venv/bin/python workstation.py run T-20260921-75c83f0a > /tmp/m9_s6run.log 2>&1 < /dev/null & disown`

## 待办队列(S6 之后,串行,同 repo)

1. S6 验收:回收沙箱 projects/T-20260921-75c83f0a 变更(retrieve.ts/retrieve.test.ts/docs/rag-arch.md)→ tsc + vitest + 真 PG 实测 → commit+accept(手动置 awaiting_review,同 S5 路径,evidence 写 evidence/m9-s6.md)
2. S7 rerank(qwen3:0.6b 对 top-20 出 JSON 排序,超时回退)+多查询改写(env RAG_RERANK/RAG_REWRITE)— codex
3. S8 前端两页:KB 块预览+检索试验台 — kimi 设计简报 + glm 编码
4. S9 切割对比实验(皇冠交付物):glm 写 runner → qwen 本地跑批 + qwen3:8b judge,3 策略 × 30 对起步,复用 experiments/ 平台,Wilson 口径
5. G2 Jev 门禁(须 ≥0.6)→ S10 安全审计(glm review)→ S11 测试报告(glm)→ G3 门禁 → S12 M9-report.md + wiki

预算:codex 2/8(S6 在途)、glm 1/8、kimi 1/3;qwen 本地不限。

## 环境(已就绪/坑)

- **PG**:容器 aichat-postgres(pgvector/pgvector:pg17,PG 17.11),端口 **5433→5432**(Windows 侧 5432 被占),数据卷 ~/docker-data/aichat-postgres,凭证从 repo/.env Python 解析注入(bash source 不生效!CRLF)。DATABASE_URL 指向 5433 需临时覆盖(见 s5_migrate2.sh 模板)
- **Docker 代理**:systemd drop-in /etc/systemd/system/docker.service.d/proxy.conf(127.0.0.1:7892)已配
- **WSL 曾自发重启**(23:40 前后),杀掉后台 run+清了 /tmp;重活考虑 tmux 保活
- 迁移链 9/9 应用,vector 扩展+Chunk(parentId/headingPath/kind/tsv+GIN)已落库,24 表
- **TS2742×9 是 prisma 生成文件既有问题(HEAD 上即有),与 M9 无关,勿修**
- pnpm 无 compose 插件;docker-compose 是 Windows 侧的;prisma 命令从 repo 根跑(prisma.config.ts 在根)

## 已验证的工作流(省额度关键)

- glm/codex 沙箱均跑不了 pnpm/tsc(权限模式)→ goal 里明确"不要自检,写完即止",验收一律 Hermes 回收后本地实测(回收脚本模板 s5_salvage.sh;严格模式修补见 fix_tsc*.py)
- 沙箱=repo 全量副本,产物在 projects/<task-id>/,回收=diff 拷贝
- 派工用 Python 列表参数(dispatch_s*.py 模板);run 后台必须 nohup+`< /dev/null`+disown
- accept 前任务须 awaiting_review(手动改 json 或先 verify)
- 脚本模板全在 E:\Hermes\cache\scratch\m9\(注意 72h 清理,过期重写)
