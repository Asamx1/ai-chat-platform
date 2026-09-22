# WSL 自发重启根因结论 (M11-B)

## 结论
WSL VM 重启 = **Windows 用户会话注销(Winlogon 6003/6000)触发**,WSL2 设计行为(VM 生命周期绑定用户会话)。非 bug、非 OOM、非 Windows 更新。

## 证据链 (2026-09-22)
- Windows 本体未重启(System 日志无 41/6008/6006,6013 显示 uptime 36h+)
- .wslconfig 已设 vmIdleTimeout=86400000(24h),排除闲置超时
- 18:58:44 Winlogon 6003/6000(注销)→ 19:01:06 Hyper-V VmSwitch 批量创建(WSL VM 冷启动)→ WSL uptime 吻合
- 9/21 01:37 亦有一次用户主动注销(1074)

## 缓解(已生效 + 建议)
1. 长任务一律 nohup + disown / tmux(现有纪律,继续)
2. 演示/答辩当天:保持登录,关闭自动锁屏与自动注销(设置→账户→登录选项;电源→屏幕关闭但不止眠)
3. MinIO/PG 用 docker 卷持久化,但**演示前必重跑幂等 demo-seed.mts**(对象曾在重启窗口丢失)
4. 若需真正的无人值守:迁移到 WSL 系统 distro 或独立 Linux 主机(超出毕设范围,不做)
