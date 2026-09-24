# M17(P3)收官报告 — 自动维护与多模态

> 日期:2026-09-27。状态:**P3 全部交付**。主仓 HEAD `235a939`,388→**398 tests 全绿**(wiki 63)。

## 任务清单(3/3 accepted)

| # | 任务 | commit | 交付 |
|---|---|---|---|
| ① | WikiJob 状态机+raw 补扫+Lint 框架 | `7fc9347` | 原子认领/退避重试 max3/指纹去重;scan-backlog diff 补扫;lint 四类检查 |
| ② | 撤回传播+推理重算+版本时效+概念降级 | `7c0987a` | maintenance.ts 四函数+CLI;retract 级联失效;幂等重算;staleness warn;降级不删文件 |
| ③ | 多模态摄入 | `235a939` | multimodal.ts(OCR/图片/字幕时间轴)+质量门槛不伪造+backlog 路由集成 |

## 验收实录(编排方真库实测)

- **补扫 E2E**:新文件入 raw/ → 自动发现注册;extract 失败正确退避回 pending(attempts 2);带 user-id 重跑清空队列
- **Lint 真库**:初跑 130 issues → 修 definition/related_to 非互斥误报 → **1**(仅剩已知孤儿 conceptprompt)
- **retract E2E**:真断言撤回 → retired 落库+级联输出(测后恢复)
- **SRT E2E**:字幕文件入 raw → parsed 3 条时间轴;VaultEvidence locator `kind=time` 时间定位落库,断言产出

## 方案验收对照(§P3)

- 中断可恢复 ✅(WikiJob 状态机+退避)
- 语义冲突有证据 ✅(lint conflicts 带 assertionIds/sourceIds)
- 多模态能定位 ✅(time locator/image 前缀/page 锚)
- 质量不足显示限制不伪造 ✅(qualityInsufficient 阻断断言产出)

## 已知边界

- PDF OCR 依赖系统 pdftoppm;视觉置信度为模型自评
- 孤儿 conceptprompt 页仍在 lint 报告中(待下次发布自然清理)
- 派工基建:任务 JSON 须预置 source_project/checks,简报入仓,启动带 nvm PATH

## 下一步

P4/M18(桌面外壳):Electron spike(方案预留 P3 末用户决策项,已按 22 问推荐锁定 Electron 倾向)。
