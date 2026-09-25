# /qa 页面整体性统一 — 单文件迁移(纯视觉)

【自动化模式】不要提问,做完退出。这是文件修改任务。禁跑构建命令。

## 改 apps/web/src/components/strict-qa.tsx

把 Tailwind 内联类迁到全站原生 CSS 令牌体系(globals.css 已有现成类):

1. 最外层容器(现为 `min-h-screen ...` tailwind 那个 div)改为:
   `<main className="page-shell page-shell-qa">`
2. 顶部导航(现为 `nav aria-label="知识问答导航"`)替换为:
   `<a className="btn page-back" href="/">← 返回聊天</a>`
   (删掉 nav 里的"知识库"链接)
3. header 区保留 `page-header` 结构:小标题紫字用 `style={{ color: 'var(--accent)' }}`,h1/p 与 /admin 的 page-header 同构(h1 24px 由 CSS 管)
4. 输入框:类改 `input input-focus`(去掉全部 tailwind border/bg/focus 类)
5. 提交按钮:类改 `btn btn-accent`
6. 结果卡(article):类改 `settings-card anim-fade-up`(padding 由 CSS 管)
7. 引用卡(li):保留 `cite-card rounded-lg border border-zinc-800 p-4` 不动(已统一)
8. 错误条、badges、推导部分、Premises 的 tailwind 类**保留不动**(语义色,迁移风险大)

## 改 apps/web/src/app/globals.css(文件末尾追加)

```css
/* ── /qa 严格问答 ── */
.page-shell-qa { max-width: 720px; }
```

## 硬约束
- 零逻辑改动:fetch/useState/表单提交/键盘事件一律不动
- 只动 className 与导航一处 JSX 结构
- result.md 列出改动行
