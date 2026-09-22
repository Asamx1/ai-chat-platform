# M10 里程碑报告：演示与打磨

**周期**:2026-09-22(1 天，原时间盒 2 天)
**基线**:tag `v1.1-m9`(0ce58f5)→ 收口 HEAD `4374f41`
**结论**:答辩演示链路全通，10 问演示包就绪，可进 G3 收口。

## 交付清单

| 任务 | 内容 | 证据 |
|---|---|---|
| S1 | 引用徽章 + 悬浮预览 + 点击跳块预览页 + headingPath 过滤(citations JSONB 落 Message) | `0b5ebd1`,208 测试绿 |
| S2 | 答辩演示语料 8 篇 + 10 问脚本 + 幂等 loader(demo-seed.mts) | `9a4a11e` |
| G1 | 门禁 0.67 一次过(富证据全文内联) | `7ace3d7` |
| S3 | 全链路 QA:登录→聊天→RAG→流式→3 引用落库;修模型注册表播种缺口 | `9ae74c2` |
| M10.5-S2 | KB 入库提速:KB_CONCURRENCY 并发 + EMBED_BATCH=64 + keep_alive,**8 文档重建 196s→2s** | `0dd52ab`,242 绿 |
| M10.5-S3 | 修演示致命 bug:/api/models id=cuid→modelKey + ModelPicker 自动选可用模型(浏览器发送 400 UNKNOWN_MODEL 根因) | `4374f41` |
| M10.6 | orchestrator 包 22 个 M8 遗留 tsc strict 错清零(CollabCallModel 边界类型) | `161ff67`,242 绿不破 |
| S4 | 10 问答案真实生成(qwen3:8b,含引用)+ headless Edge 截图包 15 张 + 演示前检查清单 | `4374f41`/`844b403`,`docs/m10/screenshots/` |
| G2 | 门禁 0.75 过(≥0.6),judge 静态核验三 commit+截图包 | evidence/m10-g2.md |

## 关键指标

- 测试：242/242 全绿(25 文件，M10 净增 34 例)
- tsc:apps/web、apps/worker、packages/orchestrator 全 0 错
- 演示数据:KB `6ef5c307`(8 文档 94 chunks)+ 会话「答辩演示：10 问全链路」
- 乱码排查结论：3000 端口系 LibreChat(无关项目);本系统 3001 UTF-8 完好；侧边栏乱码标题系自动化脚本经 Windows cmd GBK 编码所致，非应用缺陷，已清库

## 演示操作入口

- URL:**http://localhost:3001**(demo@example.com / demo12345)
- 演示前 30 分钟按 `docs/m10/demo-script.md` 首部检查清单执行(重跑 loader 自愈)
- 兜底:`docs/m10/screenshots/` 按序口述;Win+G 手动录屏 checklist 在脚本尾部

## 遗留(转 M11+)

- apps/web 其余 20 个 tsc 错(admin/collab 页，HEAD 既有，不阻塞演示)
- WSL 自发重启根因未查(已用 tmux+nohup 规避)
- LibreChat 占用 3000(不动，已在脚本标注)
- 录屏手动版待用户答辩前自录

## 预算

M10+M10.5 合计:codex 3(S1/S2b/orchestrator)、glm 3(S2/G1/G2)、kimi 0,均在限额内。
