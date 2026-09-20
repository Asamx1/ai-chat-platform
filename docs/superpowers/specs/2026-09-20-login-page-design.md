# AI-Chat 正式登录页设计

## 目标

解决未登录用户打开主页后，客户端立即请求受保护接口并显示 `HTTP 401` 的问题。提供正式、可理解的登录流程，同时保留现有 Better Auth 鉴权边界。

## 用户流程

1. 用户访问 `/`。
2. 应用读取当前 Better Auth 会话。
3. 未登录时跳转到 `/login`，且不加载会话列表或其他受保护资源。
4. 用户输入邮箱和密码并提交。
5. 登录成功后跳转到 `/`；登录失败时停留在 `/login` 并显示中文错误提示。
6. 已登录用户访问 `/login` 时自动返回 `/`。

## 页面设计

新增独立 `/login` 页面，沿用现有深色界面风格。页面包含：

- 产品名称和“登录”标题；
- 邮箱输入框；
- 密码输入框；
- 登录按钮；
- 提交中的禁用状态；
- 登录失败、网络异常等可见错误提示；
- 本地演示环境的默认账号提示：`admin@example.com`，密码不预填。

表单支持 Enter 提交，输入框具有正确的 `type`、`label`、自动完成属性和焦点顺序。

## 组件与数据流

- `app/login/page.tsx`：登录页面入口。
- 登录表单作为客户端组件，调用现有 `auth-client.ts` 暴露的 `signIn.email`。
- `app/page.tsx` 作为服务端组件，在渲染聊天应用前通过 `auth.api.getSession()` 读取会话；未登录时使用 Next.js `redirect('/login')`。
- `app/login/page.tsx` 同样在服务端读取会话；已登录用户使用 `redirect('/')` 返回主页。
- `ChatApp`（包含 `ConversationList`）只在服务端确认会话存在后挂载，因此匿名状态不会请求 `/api/conversations`。
- 登录成功后使用 Next.js 路由跳转到 `/` 并刷新服务端/客户端状态。

不修改 `/api/conversations` 等受保护接口，不引入匿名用户或自动登录后门。

## 错误处理

- 凭据错误：显示“邮箱或密码错误”。
- 网络或服务异常：显示“登录服务暂时不可用，请稍后重试”。
- 重复提交：提交期间禁用按钮。

错误提示不展示服务端堆栈、令牌或内部实现信息。

## 部署与本地冒烟安全边界

- 生产环境默认要求 `BETTER_AUTH_URL` 是不含路径、查询、片段或凭据的 HTTPS origin。
- 本地生产构建的 HTTP 冒烟必须显式设置 `AICHAT_LOCAL_SMOKE=1`，且 `BETTER_AUTH_URL` 只能是 `localhost`、`127.0.0.1` 或 `[::1]` 的 loopback origin；该开关不能用于公网 HTTP 或公网 HTTPS origin。
- 只有经过上述校验的 HTTP loopback 冒烟会关闭 Secure Cookie；HTTPS 与普通生产部署保持 Secure Cookie。
- 当前 3100 端口验收使用 `BETTER_AUTH_URL=http://127.0.0.1:3100`、`AICHAT_LOCAL_SMOKE=1` 和 `AICHAT_SECURE_COOKIES=0`，不得将这组本地冒烟配置用于非 loopback 部署。

## 测试与验收

- 路由门禁测试：未登录主页服务端重定向到 `/login`，且不会渲染 `ChatApp`；已有会话访问 `/login` 重定向到 `/`。
- 登录表单测试：提交正确参数、提交期间禁用、错误凭据显示友好提示。
- 浏览器冒烟：匿名主页重定向到 `/login`，表单登录后回到 `/`，匿名/已登录 `/api/conversations` 分别返回 401/200，已登录访问 `/login` 返回 `/`。
- HTTP 冒烟：登录接口返回会话 Cookie，携带 Cookie 请求 `/api/conversations` 不再返回 401。
- 回归：现有鉴权、聊天和启动器测试继续通过。

验收标准：新浏览器会话打开主页时看到登录页而不是 `HTTP 401`；使用种子管理员账号登录后能进入聊天主页并加载会话列表。

## 范围外

- 注册、忘记密码、第三方登录；
- 修改会话有效期；
- 自动填充或硬编码密码；
- 放宽现有 API 鉴权规则。
