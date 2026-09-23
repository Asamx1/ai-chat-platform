# M11-E 表现层变更说明

任务：T-20260923-18d4572d。依据用户附带执行版任务书及设计简报（本工作区未包含 tasks/）。

| Before | After |
| --- | --- |
| 紫色按钮、彩色状态、登录渐变与投影 | 黑白灰变量；白底黑字主按钮；边框区分表面；状态保留文案并补充成功/失败符号 |
| new-chat-btn / send-btn / stop-btn / btn-ghost / login-submit 独立控件样式 | btn + btn-primary；login-submit 仅保留宽度和高度，retry-btn 仅保留布局 |
| login-input / model-select / admin 表单独立样式 | input；model-select 仅保留等宽字体 |
| settings-badge | badge + 原有状态修饰类；引用链接也使用 badge |
| settings-page / admin-page / settings-header / settings-back | page-shell / page-shell-wide / page-header / btn page-back |
| 硬编码 smooth 滚动、不带动画的消息与引用 | CSS 控制 smooth；150ms 消息入场、180ms 视图入场、120ms 引用淡入 |
| 空消息省略号、原生方形开关、纯文字加载提示 | 三点思考、150ms 开关滑动、共享 skeleton 灰块呼吸；保留加载状态文案 |

所有动画采用 ease-out，prefers-reduced-motion 关闭动画、过渡和平滑滚动。骨架和三点呼吸周期按执行任务书使用 180ms。弱文字变量仅供装饰，正文和次要文字使用 text / text-2。保留旧 CSS 令牌及必要类别名，兼容范围外页面。

修改范围：globals.css；settings/page.tsx（容器类）；admin 的 AdminConsole、UserTable、QuotaEditor、UsageView、ModelRegistryPanel、RunsMonitor；auth/LoginForm；chat 的 ChatApp、MessageStream、Composer、StopButton、ModelPicker、ConversationList、CitationBadges；settings 的 apikey-form、ChangePasswordForm、ModelPrefForm。

API、路由、请求逻辑、状态处理、data-testid 不变。现有 web 测试未找到 className / toHaveClass / querySelector 断言，因此无对应类名断言需要修改。

验证仅安排一次无依赖静态检查：变更范围、CSS 括号与变量引用、必需基元/动效、data-testid 和 API 字面量保留、主/次文字在三个背景层上的计算对比度。该检查不等同于 CSS/TS 编译或浏览器验证。

未执行：完整 Vitest、TypeScript 构建、headless Edge 前后截图和浏览器控制台检查。工作区未安装依赖，未安装或运行外部工具；以上运行时与视觉验证留给工作站。这里的 before/after 为代码样式映射，不是截图证据。
