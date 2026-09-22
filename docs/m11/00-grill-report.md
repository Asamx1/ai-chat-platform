# M11 Grill 报告 — 产品打磨里程碑

日期:2026-09-22 · 基线:tag v1.2-m10 (7f367fd)

## 用户决策

- Q1 答辩不急,先打磨产品
- Q2-Q10 全部按推荐
- 新增需求(优先级高,排第三天):
  - 前端美观度大优化:**黑白灰设计 + 动效 + 美化 UI + 提高一体化度**
  - **优化此前补丁式代码,提高代码一体性,答辩需展示源码**

## 勘误(M10-report)

- 「apps/web 遗留 20 个 tsc 错」为旧数据,实测 M10.6 后 **apps/web tsc 0 错**(tsbuildinfo 缓存误导)

## 里程碑计划(3 天)

### Day 1 — 占位页补全(消除半成品感)
| 任务 | 内容 | 执行 | 验收 |
|---|---|---|---|
| M11-A1 | admin 页:模型注册表管理(列表/启停)+ orchestration run 监控(列表/状态/耗时) | codex | 页面可用,数据来自真 API,tsc/vitest 不破 |
| M11-A2 | settings 页:修改密码 + 默认模型偏好(localStorage 已存 modelKey,补 UI) | codex | 同上 |
| M11-B | WSL 重启根因 30 分钟速查(事件日志+wsl 日志,找不到就升级建议) | Hermes | 结论写入 ops 文档 |

### Day 2 — 纵深 + 论文素材
| 任务 | 内容 | 执行 | 验收 |
|---|---|---|---|
| M11-C | rerank 开关:retriever 接 bge-reranker(本地 Ollama),评估臂对比一臂 | codex 实现 + Hermes 跑 bench | 评估数据落 docs/experiments |
| M11-D | docs/thesis/ 素材包:索引 + 现有报告/评估数据/截图按论文章节组织 | Hermes | 索引完整,链接有效 |

### Day 3 — 美化 + 源码一体性(用户点名)
| 任务 | 内容 | 执行 | 验收 |
|---|---|---|---|
| M11-E | UI 美化专项:黑白灰配色、动效(页转场/加载态/微交互)、组件一体化(统一间距/圆角/字号体系) | codex(美工向,Hermes 出设计简报) | headless 截图前后对比,无控制台错误 |
| M11-F | 补丁一体性整理:清理 M9-M10 期间补丁痕迹(DBG 残留、类型断言、重复逻辑),统一风格,便于答辩展示源码 | glm 审查 + codex 修 | glm 审查报告 + 修复 commit |

### 门禁
- M11-G1(Day2 末,A1-C 证据全文内联)
- M11-G2(Day3 末,收口判定 → tag v1.3-m11)

## 预算

codex ≤4(A1/A2/C/E)、glm ≤3(F 审查+2 门禁)、kimi ≤1、Hermes 编排+B/D 零预算。

## 纪律

- 任务粒度 ~1h,单次运行 ≤2h;同 repo 串行
- 完成定义:A1/A2 可用 + rerank 臂数据 + docs/thesis/ 索引 + UI 美化前后对比 + 补丁整理 + 242 测试不破 + tag v1.3-m11
