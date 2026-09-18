| 方法 | 路径 | 请求 | 响应 | 鉴权 | 幂等 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| POST | /api/chat/send | {conversationId?,content,modelKey,idempotencyKey} | {conversationId,messageId,runId} | session | idempotencyKey幂等 |
| POST | /api/chat/stop | {runId} | {ok:true} | session | 幂等 |
| GET | /api/runs/[runId]/events | - | SSE Last-Event-ID续传 | session | 只读 |
| GET | /api/conversations | - | {items,total} | session | - |
| POST | /api/conversations | {title,type} | {id} | session | - |
| POST | /api/auth/sign-in/email | {email,password} | {token,user} | 公开 | - |