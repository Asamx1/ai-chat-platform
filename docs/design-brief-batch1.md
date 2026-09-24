# AI-chat 前端美观翻新 — 第一批(chat+login+qa,纯视觉层)

【自动化模式】不要中途提问,全部做完再退出。这是**文件修改任务**:用编辑工具直接改以下文件。禁跑构建命令(pnpm/npx/next/tsc/vitest)。

## 任务(只做这三块,别的页面第二批做)

### 1. apps/web/src/app/globals.css

在 :root 令牌区(**保留全部现有变量与 legacy 别名**)追加:
```css
--accent: #A855F7;
--accent-hover: #9333EA;
--accent-soft: rgba(168, 85, 247, 0.12);
--accent-ring: rgba(168, 85, 247, 0.45);
```
文件末尾追加动画段:
```css
@keyframes fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.anim-fade-up { animation: fade-up 180ms ease-out both; }
.anim-fade-in { animation: fade-in 150ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .anim-fade-up, .anim-fade-in { animation: none; } }
```

### 2. apps/web/src/components/chat/*.tsx(6 文件,className 级改动)

- ConversationList.tsx:选中会话 → 加 `style={{ background: 'var(--accent-soft)' }}` + 左侧 2px 紫条(`border-left: 2px solid var(--accent)`);「+ 新建」按钮改 `style={{ background: 'var(--accent)', color: '#fff' }}`,hover 深紫可不做(JSX 内联无伪类,保持简单)
- MessageStream.tsx:消息卡片容器加 className `anim-fade-up`
- Composer.tsx:输入框 focus 紫环——原生 CSS 做不了内联 focus,在 globals.css 追加 `.composer-input:focus { border-color: var(--accent-ring); box-shadow: 0 0 0 3px var(--accent-soft); }` 并给输入框加该类;发送按钮紫底白字
- CitationBadges.tsx:徽章 `style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}`
- ModelPicker.tsx:选中项文字色 `var(--accent)` + 左侧小圆点
- ChatApp.tsx:根容器加 `anim-fade-in`

### 3. apps/web/src/components/strict-qa.tsx

- 全部硬编码 `text-purple-300`/`#A855F7`/`purple-*` tailwind 类换成 `style` 引用 var(--accent) 系列(或保留 tailwind 但值统一 #A855F7)
- 状态徽章:no_evidence 琥珀(border-amber-600/50 text-amber-300)、out_of_scope 锌灰、正常回答 var(--accent-soft) 底
- 引用卡 hover:globals.css 追加 `.cite-card:hover { border-color: var(--accent-ring); }`,引用卡加 cite-card 类
- 结果卡容器加 anim-fade-up

### 4. apps/web/src/components/auth/*.tsx(login)

- 卡片容器 anim-fade-up;输入框 focus 走 .composer-input 同款(重命名为通用 `.input-focus` 类,globals.css 里一份两用)
- 登录按钮:保持白底黑字(Linear 式),但 hover 时 border 变 var(--accent)

## 硬约束

- 零逻辑改动:不动 fetch/useState/事件/路由;只加 className/style/包裹元素
- 零新依赖;不动 api/ 与 packages/
- result.md 列改动文件清单
