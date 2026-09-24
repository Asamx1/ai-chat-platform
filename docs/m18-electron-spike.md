# M18 Electron spike：桌面宿主骨架

任务：P4/M18 任务①；工作单 T-20260925-1b7ac1b3。

## 结论与证据边界

二选一推荐 **Electron**，但仅作为下一步实测候选，不代表已经完成打包验证或正式框架定案。Next.js **16.3.5** 是 Web 框架版本；Electron 声明 **^37**，electron-builder 声明 **^26**，二者版本不可混称。

可行性推断：独立 Electron 主进程可以加载现有 Next.js HTTP 服务，同时用本地向导承接 Web 尚未启动的情况。此次交付实现该生命周期骨架，不修改 apps/web，不安装依赖、不运行构建、不生成安装器。Windows 启动、真实数据库认证、NSIS 安装和进程退出均待外部实测。

与 Tauri 比较：Tauri 外壳通常更小，但仍需解决 Next.js Node 服务与 Docker 依赖的分发，当前 Electron 更直接复用 Node 生命周期管理能力。

## 已实现的路径

- 主进程单实例锁；第二次启动聚焦已有窗口；1400×900、最小 1024×700。
- 每次启动先显示本地向导（包含首次初始化）；vault 默认 `D:\wiki-vault`，仅检查目录和打开目录，不创建、不修改；可用 `AICHAT_VAULT_PATH` 覆盖。
- `probe()` 用 Promise.all 并行检查 PostgreSQL 5433、MinIO 9000 `/minio/health/live`、Web 3001 `/login`。PostgreSQL 先通过 node:net 建立 TCP，再用 pg 的 TCP 协议客户端执行 SELECT 1；避免手写不完整的 SCRAM/MD5 认证协议。HTTP 仅 200 算就绪，不将重定向当成功。
- Docker 依赖异常返回逐项状态，发出 `docker-dependency-down`，向导展示引导；不会运行 Docker 命令。
- `startWeb()` 合并仓库 `.env` 与宿主环境（已有宿主变量优先），保留数据库用户名、密码、库名与查询参数，强制数据库主机/端口为 127.0.0.1:5433；覆盖 PORT、BETTER_AUTH_URL 与 NEXT_PUBLIC_APP_URL 为 3001 对应地址。
- 使用开发仓库 `apps/web` 作 cwd，执行 `npx --no-install next start -p 3001`；禁止隐式下载。Windows 通过 cmd.exe 调用 npx.cmd，参数固定。stdout/stderr 追加到 Electron userData 下 `logs/web.log`。轮询 `/login`，默认 60 秒；失败清理自己启动的服务，重复点击共享启动任务。外部已启动的健康 Web 不纳入进程所有权。
- 退出时取消就绪等待；Unix 进程组先 SIGTERM，5 秒后 SIGKILL；Windows 使用 taskkill /T，再超时 /F 清理进程树。Windows 没有等价的 POSIX SIGTERM 保证，普通 taskkill 是否能让 Next 完成请求必须实测；这是 spike 限制。只终止宿主启动的子进程，不停止 Docker 或外部 Web。
- contextBridge 只暴露 probe/startWeb/openVaultFolder/getState 与依赖事件订阅；隔离上下文、关闭 nodeIntegration、启用 sandbox，主进程核验 IPC 主框架与来源。Vault 路径不能由渲染端任意传入；弹窗与跨来源导航禁止。

## 打包与运行前提

`electron-builder.yml` 配置 NSIS、appId `com.aichat.desktop`、产物名 `aichat-setup-${version}.exe`。`scripts/package.mjs` 顺序执行 Web next build（通过 pnpm filter）、桌面 TypeScript 编译、electron-builder；任一步失败立即停止。本轮没有执行该脚本。

已有 workspace 的 `apps/*` 通配会包含新包；没有改 workspace 配置或锁文件，依赖解析/锁文件更新由后续获授权环境完成。桌面 package.json 单独声明全部依赖。

安装后需显式设置 `AICHAT_REPO_ROOT` 指向开发仓库；源码启动默认推导仓库根。仓库必须已有依赖、成功的 Next production build、正确 secrets 与可用外部 Node/npm/npx。Node 版本须满足仓库 engines。构建时也需要正确生产环境和公开 URL，本脚本沿用调用环境。不能把安装器解释成离线独立产品。

`extraResources` 为空，不复制 web/node_modules 或 `.env`。桌面自身生产依赖仍由 builder 正常打入应用。当前使用外部 Node 运行 next start，尚未随包提供 Web Node runtime；下一阶段需验证随包 Node 或 Next output standalone（仍需 Node、静态文件及运行时资源），本任务不改 Web 配置。Docker、数据库与 MinIO 数据不随安装包提供。

未经测量的预算估算：Windows x64 Electron 外壳压缩安装包约 80–150 MB，安装后约 200–350 MB；加入 Web、Node、原生依赖后可能显著增大。实际体积、签名、杀软表现与冷启动时间须用真实 NSIS 产物记录。

## 测试与待验证项

`test/service-manager.test.ts` 提供关闭端口探测、Docker 提示、环境覆盖、fake spawn 启动参数/失败/重复启动合并、单实例锁 mock 测试。本轮未执行这些 Node 测试，也未执行 TypeScript 编译。

后续外部验证应覆盖真实 PostgreSQL SELECT 1、MinIO 故障提示、日志写入、/login 超时、第二实例聚焦、关闭窗口后无 Next 残留、Windows 安装卸载及含空格仓库路径。当前 infra/compose.yaml 默认映射 5432，任务指定实测环境为 5433；本任务遵从 5433，未修改基础设施。

升级迁移、备份恢复、后台 worker 管理、Docker 自动安装/编排、代码签名和自动更新均未实现，属于后续一体化工作，不能由当前骨架推定完成。外部运行与打包验证仍待执行。
