#!/usr/bin/env bash
# AI-Chat 演示:WSL 内拉起 worker(tmux 驻留)
set -u
tmux kill-session -t aichat-worker 2>/dev/null
tmux new-session -d -s aichat-worker 'bash -c "source /tmp/m10logs/env.sh; export PATH=/home/codex/.nvm/versions/node/v24.16.0/bin:/usr/local/bin:/usr/bin:/bin; unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; cd /home/codex/code/ai-chat-platform/repo/apps/worker; exec corepack pnpm dev > /tmp/m10logs/worker.log 2>&1"'
echo "worker-launched(tmux:aichat-worker)"
