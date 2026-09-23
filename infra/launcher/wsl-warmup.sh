#!/usr/bin/env bash
# web 预热:并发 curl 关键路由,触发 Next dev 编译。由 start-demo.ps1 调用。
mkdir -p /tmp/m10logs
rm -f /tmp/m10logs/warmup.done
for p in /login / /settings /kb /api/models; do
  curl -s --noproxy '*' -m 60 -o /dev/null -w "%{http_code} $p\n" "http://127.0.0.1:3001$p" &
done
wait
touch /tmp/m10logs/warmup.done
