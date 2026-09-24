# P4/M18 任务①:Electron spike + 桌面宿主骨架(生命周期管理)

【自动化模式】不要中途提问、不要读 skill、不要浏览器操作;全部做完再退出。自由用文件工具读源码;禁跑构建命令(pnpm/npx/prisma/tsc/vitest/node/electron),写完即止,验收由编排方本地实测打包。

## 背景

M17 已收官(245c408)。方案 §L211-234 与 grill Q19:桌面外壳倾向 Electron,但**打包验证后才能定**——本任务就是 spike。方案硬性要求:一个安装/启动入口、初始化向导、服务健康检查、后台任务启停、升级迁移与备份;用户不必分别启动 postgres/web 或在多个终端执行命令。

现状:apps/web 是 Next.js 16.3.5(pnpm monorepo,apps/web 下 `npx next dev -p 3001` 可跑);postgres 在 docker(aichat-postgres,127.0.0.1:5433);minio 在 docker;BETTER_AUTH_URL=http://localhost:3001;DATABASE_URL 用 127.0.0.1:5433(.env 里 localhost:5432 是死端口,桌面壳启动 web 时须覆盖——编排方实测踩过)。

## 交付物

1. **apps/desktop/**(新包,不进 pnpm workspace 也行,独立 package.json):
   - `src/main.ts`:Electron 主进程——单实例锁、创建主窗口(1400x900,min 1024x700)、加载 web 入口
   - `src/services/service-manager.ts`:依赖编排核心
     - `probe()`:并行健康检查(写 pg 5433 TCP 探测+SELECT 1 via net;minio 9000;web 3001 HTTP /login)返回每项 {name, state: up|down, detail}
     - `startWeb()`:以子进程启动 web(`pnpm --filter @aichat/web start` 或 `npx next start -p 3001`,cwd=repo/apps/web),env 注入 DATABASE_URL 覆盖(127.0.0.1:5433),stdout/stderr 落日志文件(%USERDATA%/logs/web.log),就绪探测轮询 /login 200
     - `stopAll()`:优雅退出(SIGTERM+超时 kill)
     - docker 依赖(postgres/minio)down 时:报告+给出引导 UI 事件(`docker-dependency-down`),不自动拉起容器(用户决策,先如实上报)
   - `src/ipc.ts`:contextBridge 暴露 `desktop.probe()/desktop.startWeb()/desktop.openVaultFolder()/desktop.getState()`(preload,禁 nodeIntegration)
   - `src/wizard/`:首启动初始化向导页(本地 HTML,不依赖 web)——vault 路径检测(默认 D:\wiki-vault,不存在则黄条警告)、依赖状态清单、「启动服务」按钮触发 startWeb 后跳主窗口
2. **打包配置**:`electron-builder.yml`(win nsis,appId com.aichat.desktop,artifactName aichat-setup-${version}.exe;extraResources 不含 node_modules——运行时用 dev 仓的 web,spike 阶段如实标注局限)+ `scripts/package.mjs`(串 next build → electron-builder)
3. **测试**(`test/service-manager.test.ts`,node:test 或 vitest 均):probe 对不存在端口返回 down;startWeb 的 env 覆盖逻辑单元测(注入 fake spawn);单实例锁行为 mock 测
4. **spike 结论文档**:`docs/m18-electron-spike.md`——Electron 16.3.5 Next.js 方案可行性、打包体积预估、限制(next start 需 node 运行时随包/或 output standalone)、与 Tauri 对比一句话结论、推荐二选一

## 边界

- 不真正打包(编排方跑);不装 Electron 二进制(package.json 声明 devDependencies 即可,electron-builder 版本 ^26,electron ^37)
- 不改 apps/web 任何代码
- 不动 D:\wiki-vault
- main 进程 TypeScript,tsconfig 独立

## 参考文件

repo/package.json(pnpm workspace)、apps/web/package.json、docs/ontology-wiki-plan-v2.md L211-234(本阶段验收)
