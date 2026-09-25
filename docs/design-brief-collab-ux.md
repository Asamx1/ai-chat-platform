# collab-ux 前端优化设计简报（Kimi 执行单输入）

> 输入：docs/00-grill-report-collab-ux.md（先读）。范围=纯前端,零后端改动,零新依赖。
> 逐文件逐条照做,不自检不跑测试,写完即止。类名契约见文末,不得自创类名。

## 通用纪律
- 只改列出的文件;CSS 全部追加到 apps/web/src/app/globals.css 末尾 collab-ux 段,复用既有令牌(--surface/--surface2/--border/--text/--text-2/--primary/--radius),紫=#A855F7 一律走 var(--primary),禁止新配色
- 入场动画复用 settings-card 的 fade/slide 手法;聚焦环复用 input:focus-visible 紫环写法
- i18n 不引入;中文硬编码即可(现有代码即如此)
- tsc noUncheckedIndexedAccess 严格模式必须过:数组索引访问一律 ?. 或 ! 收窄

## A. CollabLauncher.tsx(222行) — 6 处改动

### A1 席位预设模板(决议①)
- state 之上加 const PRESETS = [{key:"quick",label:"2席·快速",count:2,roles:["candidate","reviewer"]},{key:"standard",label:"3席·标准",count:3,roles:["candidate","candidate","reviewer"]},{key:"deep",label:"5席·深度",count:5,roles:["candidate","candidate","reviewer","summarizer","synthesizer"]}] as const
- 席位区顶部渲染三个 preset-chip 按钮,点击=setSeats(按 count 重建,role 按 roles 赋,modelId 按 MODEL_OPTIONS 轮转,systemPrompt 清空,renumber)
- 当前 seats.length 与 preset.count 相同且角色序列一致时该 chip 加 is-active

### A2 模式与角色中文化+悬浮说明(决议②)
- 加 const MODE_META: Record<CollabMode,{zh:string;hint:string}> = { GROUP:{zh:"自由讨论",hint:"各席位独立作答后汇总,观点并呈"}, CONSENSUS:{zh:"共识收敛",hint:"多轮互相评论,逐步收敛出一致结论"}, DEBATE:{zh:"正反交锋",hint:"席位分正反方轮番交锋,评审裁定"} }
- 加 const ROLE_META: Record<SeatRole,{zh:string}> = { candidate:{zh:"候选作答"}, reviewer:{zh:"审校把关"}, summarizer:{zh:"要点提炼"}, synthesizer:{zh:"综合成稿"} }
- 模式 radio label 显示 m 加中文后缀(MODE_META[m].zh),title=hint;模式区下方加一行 collab-mode-hint 显示当前模式 hint(12px,--text-2)

### A3 DEBATE 解锁(决议①前置)
- 删除 disabled 的 DEBATE label,把 DEBATE 并入正常 map 循环:CollabMode 类型改 "GROUP" | "CONSENSUS" | "DEBATE";POST body 的 mode 字段即字符串,后端已支持,零契约改动

### A4 tokenBudget 档位化(决议③)
- const BUDGET_TIERS = [{key:"lite",label:"省",value:40000},{key:"std",label:"标准",value:100000},{key:"rich",label:"充足",value:250000}] as const + 自定义档
- 三档 chip(写法仿 preset-chip),点击直设 value 并隐藏数字输入;第 4 个 chip「自定义」点开显示原 number input
- 档位切换时同步 title="token 预算上限"

### A5 配置记忆(决议④)
- key 用 "aichat.collab.lastConfig";launch 成功前(setOpen(false) 处)localStorage.setItem(JSON.stringify({mode,seats,tokenBudget}))
- 组件初挂载 useState 初始化函数里 try/catch 读回,parse 失败/结构不对则回退 initialSeats();读回的 seats 逐项校验 modelId∈MODEL_OPTIONS、role∈ROLES,不合法字段回退默认;SSR 安全(window 检查)

### A6 错误与提交态微调
- error div 加 class collab-error;发起按钮 submitting 时加 is-loading,文字不变

## B. SeatStatus.tsx(169行) — 3 处改动

### B1 轮次进度条(决议⑤)
- 顶部 header 下方加 round-progress:按 rounds 数组渲染进度点(dots,一 round 一点,完成态紫色);无轮次时隐藏

### B2 每席耗时徽标(决议⑤)
- seat-card-meta 已有耗时文本;将其改为 badge 形态 seat-duration-badge(紫边圆角小徽标,12px);speaking 态保留「发言中…」文本

### B3 live 输出预览(决议⑤)
- seat.started 时若 payload 带 delta/provider.delta 事件流不接入(那是 RunTimeline 职责);本项改为:seat-card 在 speaking 态加 spinner 点动画(三点跳动,CSS-only,class seat-speaker-dots),不新增 SSE 事件订阅

## C. RunTimeline.tsx(205行) — 2 处改动

### C1 席位观点折叠对比(决议⑥)
- 新增 export function SeatOpinions({runId, finalAnswer}: {runId:string; finalAnswer?:string}):加载 events?format=json,取 payload.seatId 且带 delta 或 output 文本的事件(collab.seat.completed 的 payload 若含 text/output 字段则用,否则跳过),按 seat 聚合成 <details class="seat-opinion"><summary>s1 · 候选作答</summary>正文</details> 列表;finalAnswer 存在时上方加 <div class="final-answer-card">高亮卡(紫左边框+--surface2 底)
- ChatApp.tsx 的 collab-side 里,在 OrchestrationProgress 之后插入 <SeatOpinions runId={collabRunId}/>(import 语句同步加)

### C2 事件类型徽章中文化(决议②延伸)
- typeClass 不动;在事件行渲染处加 typeZh 映射:run.succeeded→运行成功 / run.failed→运行失败 / run.cancelled→已取消 / collab.seat.started→席位开讲 / collab.seat.completed→席位完成 / round.completed→轮次完成 / 其余保留原文;徽章显示中文,悬浮 title 注事件原文 

## D. globals.css — 末尾新增 collab-ux 段
- .preset-chip / .preset-chip.is-active / .budget-chip(复用 preset-chip 形态)/ .collab-mode-hint / .collab-error / .round-progress 与 .round-dot / .round-dot.is-done / .seat-duration-badge / .seat-speaker-dots(三点跳动 @keyframes)/ .seat-opinion / .final-answer-card
- 全部复用既有令牌;active 态边框+文字 var(--primary);hover 态 border-color 过渡 0.15s;禁止 position:fixed

## 交付物
- result.md:改动文件清单+每处要点+新增类名清单;不得自跑 tsc/vitest(沙箱无 node)

## 验收(回收方 Hermes 执行)
- npx tsc -b 严格 0 错;pnpm vitest web 全绿;headless Edge:面板开合/席位增删/预设切换/DEBATE 可选/中文标签出现/刷新后配置回填;真发起 2 席 GROUP SSE 跑通;SeatOpinions 渲染非空
