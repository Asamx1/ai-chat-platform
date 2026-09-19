| phase | 事件 | payload 要点 | 发起者 | M3/M4 标注 |
| :--- | :--- | :--- | :--- | :--- |
| PLANNING | `run.planning` | `{mode, seats}` | engine | M3 (Engine/Worker) |
| ROUND | `provider.call.started` | `{seatId}` | worker | M3 (Worker) |
| ROUND | `provider.call.completed` | `{seatId, usage, tokens}` | worker | M3 (Worker) |
| ROUND | `run.round.completed` | `{round, seatsDone}` | strategy | M3 (Strategy/Engine) |
| SYNTHESIZING | `provider.call.completed` | `{seatId: 'synth', ...}` | strategy | M3 (Strategy/Engine) |
| JUDGING | `judge.result` | `{winner, confidence}` | 裁判 (M4) | **M4** (Judge) |
| 终态 | `run.succeeded` | `{assistantMessageId}` | worker | M3 (Worker) |
| 终态 | `run.failed` | `{error}` | worker | M3 (Worker) |
| 任意 | `provider.delta` | `{delta, seatId}` | worker | M3 (Worker) |
| 任意 | `run.cancelled` | `{}` | worker | M3 (Worker) |

**说明：**
- **M3 实现部分**：涵盖 Planning、Round（含 Provider 调用与 Delta）、Synthesizing 及终态成功/失败事件，主要由 Engine、Strategy 和 Worker 组件处理。
- **M4 实现部分**：仅包含 Judging 阶段的 `judge.result` 事件，由裁判模型（Judge）生成并返回。