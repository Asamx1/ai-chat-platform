# AI-chat 前端美观翻新 — DESIGN 简报(kimi-k3 美工)

【自动化模式】不要中途提问;全部做完再退出。禁跑构建命令(pnpm/npx/next/tsc/vitest),写完即止,验收由编排方实测。

## 设计方向(锁定,不可偏离)

极简暗色 + 单一紫色强调。气质参考 Linear/Vercel 的克制精致,不要花哨渐变大色块。

### 令牌改造(apps/web/src/app/globals.css :root)

现有:--bg #0a0a0b / --surface #141416 / --surface2 #1c1c1f / --border #2a2a2e / --primary 白。

改为:
- `--accent: #A855F7`(核心紫,全站唯一强调色)
- `--accent-hover: #9333EA`(hover 深一档)
- `--accent-soft: rgba(168, 85, 247, 0.12)`(选中态底色/徽章底)
- `--accent-ring: rgba(168, 85, 247, 0.45)`(焦点环)
- `--primary` 保持白(主按钮仍白底黑字,Linear 式),但**主交互色/链接/选中/焦点/进度**全走 --accent
- 保留全部 legacy 别名不删(防破其他引用)

### 动效(纯 CSS,零依赖,零 JS 库)

- 消息/卡片入场:`@keyframes fade-up`(opacity 0→1 + translateY 6px→0,180ms ease-out)
- 按钮/列表项 hover:背景色过渡 120ms + 轻微 translateY(-1px)
- 引用徽章:默认 --accent-soft 底,hover 边框亮紫
- 页面容器进入:opacity 0→1(150ms)
- **禁止**:跟随鼠标的动效、大面积 parallax、循环播放的 shimmer
- `@media (prefers-reduced-motion: reduce)` 全部禁用

## 逐页要求(优先级从高到低)

### 1. chat 主页(components/chat/*,最优先,用户 90% 时间)

- ConversationList:选中会话 --accent-soft 底+左侧 2px 紫色指示条;hover 微亮
- 「+ 新建」按钮:改 --accent 底白字(目前应是白底),hover --accent-hover
- MessageStream:消息卡片 fade-up 入场;用户气泡与 assistant 气泡层次拉开(用户偏紫 tint:--accent-soft 或保持灰但边框带紫调,二选一,以克制为准)
- Composer 输入框:focus 时边框 --accent-ring;发送按钮 --accent 底
- CitationBadges:徽章 --accent-soft 底紫字
- ModelPicker:选中项紫色对勾/指示

### 2. login(auth 组件)

- 居中卡片 fade-up;主「登录」按钮可改 --accent 底白字(或保持白底,以整体协调为准)
- 输入框 focus 紫环;演示账号提示行用 --text-2

### 3. qa 严格问答(components/strict-qa.tsx)

- 已有 text-purple-300/#A855F7 散点**统一收敛到令牌**(替换硬编码)
- 状态徽章(answer/no_evidence/out_of_scope):no_evidence 用琥珀边、out_of_scope 用锌灰,正常回答用 --accent-soft 紫底
- 引用依据 details 展开:箭头旋转过渡;每条引用卡 hover 边框紫

### 4. kb 知识库

- 文档列表行 hover 紫 tint;上传区虚线框 hover 变紫;卡片 fade-up

### 5. admin / settings

- 表格斑马纹 --surface;操作按钮 hover 紫;tab 选中下划线 --accent

## 硬性约束

- **零逻辑改动**:不动任何 fetch/useState/事件处理器/路由;只动 className/内联样式/新增 CSS 类/DOM 微调(可加包裹 span/div 做动画)
- **零新依赖**:不装任何包(无 framer-motion/gsap/lucide)
- 不动 apps/web/src/app/api/、不动 packages/
- tailwind 若在用(检查过:项目用原生 CSS+tailwind 混合,className 里有 tailwind 类),tailwind 类可自由使用 zinc-*/purple-* 系列
- 改完 globals.css 必须 ≤1400 行(增量克制)

## 交付物清单

1. globals.css(令牌+动效 keyframes+新组件类)
2. components/chat/*.tsx(六文件视觉层)
3. components/auth/*.tsx
4. components/strict-qa.tsx
5. components/kb/*.tsx
6. components/admin/*.tsx、settings 相关

result.md 列出改动文件清单+每页一句话改动摘要。
