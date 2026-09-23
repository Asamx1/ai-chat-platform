#!/usr/bin/env bash
# AI-Chat 演示:WSL 内拉起 web(dev :3001,tmux 驻留;路径全硬编码防 sh 预展开)
set -u
mkdir -p /tmp/m10logs
cd /home/codex/AI-Workstation
.venv/bin/python /home/codex/code/ai-chat-platform/repo/infra/launcher/fullenv.py > /tmp/m10logs/env.sh
tmux kill-session -t aichat-web 2>/dev/null
tmux new-session -d -s aichat-web 'bash -c "source /tmp/m10logs/env.sh; export PATH=/home/codex/.nvm/versions/node/v24.16.0/bin:/usr/local/bin:/usr/bin:/bin; unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; cd /home/codex/code/ai-chat-platform/repo/apps/web; exec corepack pnpm dev -p 3001 > /tmp/m10logs/web3001.log 2>&1"'
echo "web-launched(tmux:aichat-web)"
