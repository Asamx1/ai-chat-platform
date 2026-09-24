# P3/M17 任务③:多模态摄入 — OCR、图片理解、字幕时间轴

【自动化模式】不要中途提问、不要读 skill、不要浏览器操作;全部做完再退出。自由用文件工具读源码;禁跑构建命令(pnpm/npx/prisma/tsc/vitest/node),写完即止,验收由编排方本地实测。

## 背景(编排方实测)

任务①②已交付(commit 7c0987a):scan-backlog 已有 needsOcr 计数与 enqueued 流程,job 走 WikiJob 状态机。本任务补齐方案 §2 的多模态解析(L133「解析正文、图片、表格或字幕并保留定位」+ §验收「多模态能定位」「图片/OCR/字幕质量不足:显示限制,不伪造」)。

现状:packages/wiki/src/parse.ts 只处理文本/md;scanRawFile 对非文本返回 needsOcr(读 scan.ts 确认);VaultEvidence 有 locator 定位结构(读 schema 确认字段名)。多模态 LLM 复用 extract.ts 的 deepseekLlm 模式(AICHAT_USER_ID + ApiKey 表),模型用 deepseek-vl(见下)。

## 交付物

1. **packages/wiki/src/multimodal.ts**:
   - `ocrFile(vaultPath, relPath, opts)`:对 PDF/扫描件页做 OCR——实现上允许两种后端:`paddleocr`(若可执行)或 LLM 视觉(deepseek-vl,base64 图),产物写入 vault 的 `extracted/<source-id>/ocr.txt`(带每页/每屏的定位锚 `[page:N]`);输出 {pages, textLength, backendUsed}
   - `parseSubtitles(vaultPath, relPath)`:SRT/VTT → 时间轴条目 {startMs, endMs, text};生成 `extracted/<source-id>/subtitles.json`;行内定位 `subtitle:hh:mm:ss-hh:mm:ss`
   - `describeImage(vaultPath, relPath, opts)`:图片 → deepseek-vl 描述 + 可选 OCR 叠加;产物 `extracted/<source-id>/images/<name>.md`;断言抽取复用 extractAssertions(喂描述文本),evidence locator 带 `image:<name>` 前缀
   - `ingestMultimodal(vaultPath, relPath, opts)`:路由——按扩展名分派 ocr/subtitles/image,复用 ingest.ts 的注册与断言管线(源类型注 multimodal),错误转 needsOcr/qualityInsufficient 时如实上报不伪造
2. **scan-backlog 集成**:scanBacklog 处理 needsOcr 文件时改调 ingestMultimodal(而非直接 failed)
3. **质量门槛**:OCR 平均置信度/字幕覆盖率过低 → report 标 `qualityInsufficient: true` + 原因,断言不产出(方案 L277:显示限制不伪造)
4. **测试**(packages/wiki/test/multimodal.test.ts):
   - parseSubtitles:内联 SRT 字符串 fixture → 条目数/时间轴换算/定位格式
   - ocrFile:mock LLM(注入 fake llm 返回固定文本)→ 产物文件写入+backendUsed=llm
   - ingestMultimodal 路由:按扩展名分派正确;质量不足→qualityInsufficient
   - 不要求真视觉模型跑通(mock 即可,真库验证编排方做)

## 边界

- 不新增 npm 依赖(视觉后端走 HTTP API,用现有 fetch;SRT/VTT 手写解析)
- 不改 prisma schema
- extracted/ 产物写入 D:\wiki-vault 对应 vault 路径(运行时由 vaultPath 决定,测试用临时目录)
- deepseek-vl 模型名:'deepseek-vl2-turbo';API 端点与 key 从 ApiKey 表取(与 deepseekLlm 同模式)

## 参考文件

packages/wiki/src/parse.ts、scan.ts、extract.ts(deepseekLlm)、ingest.ts、jobs.ts、test/maintenance.test.ts(fixture 模式)
