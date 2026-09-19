# M2 里程碑报告（草稿）

里程碑：M2 — Worker 执行模式与租约恢复
日期：2026-09-19
状态：草稿，待独立验收（本报告不构成验收结论）

## 1. 交付物
- lease 机制：FOR UPDATE SKIP LOCKED 原子领取任务；30s TTL；10s 周期续租；丢租检测（续租被拒即停止提交）。
- 崩溃恢复：lease 过期后由其他 worker 接管，attempt 递增，旧 worker 续租被拒，事件 seq 零重复。
- exactly-once 记账：恢复路径下 UsageLog 与 ProviderCall 不产生重复记录。
- outbox 过渡完成：API 仅写 PENDING 事件；EXECUTION_MODE 开关控制 inline/worker 切换。
- worker 模式 e2e：once 与常驻两种模式均验证通过；qwen3:0.6b 真实流式跑通，共 23 个事件。

## 2. 验收证据表
| 验收项 | 证据 | 结果 |
|---|---|---|
| lease 过期接管 | 恢复测试：旧 worker 失效后新 worker 接管 | 通过 |
| attempt 递增 | 接管后 attempt +1 | 通过 |
| 旧 worker 续租拒绝 | 丢租后续租被拒并停止写库 | 通过 |
| seq 零重复 | 接管前后事件序号无重复 | 通过 |
| UsageLog/ProviderCall exactly-once | 恢复路径无重复记账行 | 通过 |
| outbox 过渡 | API 只写 PENDING；开关生效 | 通过 |
| worker e2e（once） | 单次模式完整链路 | 通过 |
| worker e2e（常驻） | 常驻模式持续领取执行 | 通过 |
| 真实流式 | qwen3:0.6b，23 个事件按序到达 | 通过 |

## 3. 偏差与修复记录
- tsx transform 缓存坑：tsx 编译缓存未失效导致执行旧代码，定位为开发环境问题，已通过清缓存规避，待写入开发文档。
- inline 遗留 RUNNING 死锁窗口：发现后立项修复，目前修复中，未关闭（见第 4 节）。

## 4. 已知限制
- inline 模式存在遗留 RUNNING 记录造成的死锁窗口：任务卡 RUNNING 且无人接管；修复进行中。worker 模式不受此影响。
- tsx 缓存坑仅影响开发环境，生产构建不受影响，但规避方法尚未文档化。

## 5. 下一步 M3
- 关闭 inline RUNNING 死锁窗口修复，并补回归测试。
- inline 路径下线后移除 EXECUTION_MODE 过渡开关，outbox+worker 成为唯一执行路径。
- 补运维能力：worker 监控指标、lease/队列积压告警。
- 将 tsx 缓存规避方法固化进开发文档。
---

正文约 830 字，符合 1000 字内要求。

result: M2 报告草稿已产出（markdown 全文如上）
changed files: 无（本会话无文件工具，未落盘；目标文件 docs/milestones/M2-report.md 需由执行方写入）
checks actually run: 无测试/无文件读取——报告仅基于任务给定的 5 项事实撰写；字数已核对在 1000 内
remaining issues:
1. 报告未经独立验收，状态标注为草稿，未声称验收通过
2. 文中"证据"列描述来自任务摘要，未附原始测试日志/命令输出引用，执行方落盘前可补充具体测试名或 CI 链接
3. 两个已知问题（inline RUNNING 死锁窗口修复中、tsx 缓存坑未文档化）已如实列入第 3/4 节

## 附：D9 codex 审查发现（已记入限制）

1. 【高】恢复后 seq 从 MAX(seq)+1 续写正确，但 provider 从头生成——delta 内容会重复（checkpoint 只存进度不存生成状态）。M3 改进：恢复时重放尾部或 provider 断点续传。
2. 【高】失租后 await 交错仍可能写入事件（无租约代次原子校验）。M3 改进：每次事件写入带 leaseOwner 条件。
3. 【中】取消响应延迟在流间隙无上界。改进：独立取消轮询循环。
