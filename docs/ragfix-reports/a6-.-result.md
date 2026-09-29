# A6 配套 RAG 测试结果

任务已按“当前工作树不含 A3 修复，先写测试预期红”完成。未修改任何 src、既有测试或 root/worker 既有配置；没有新增依赖。本文是简报明确要求的根目录交付文件，其他新增文件均位于指定测试目录。

## 新增文件

- `packages/rag/test/inject.test.ts`：3 个共享注入函数测试。
- `apps/worker/test/runner-rag.test.ts`：2 个 worker 路径测试。
- `apps/worker/test/collab-rag.test.ts`：3 个双席位协作测试。
- `apps/worker/test/rag-fixture.ts`：两套 worker 测试共用的最小 DB/lease 桩、检索数据和 provider 工厂。
- `apps/worker/test/rag.vitest.config.ts`：独立执行上述两个 mock worker 文件，跳过真实 DB setup。

既有 runner/collab 测试直连数据库，未导出可复用 DB 桩或 fake orchestrator。新测试沿用既有 vi.mock 风格，provider 直接复用仓库的 `FakeProvider`，worker/collab 共用一套新 DB 桩，不复制两份。fake orchestrator 使用真实协作回调接口调用两个席位，并保留实际 runner 的注入、provider 调用、记账与收尾路径。

## 覆盖点

- 证据是 user 消息，起止 `RAG_DATA_<nonce>` / `END_RAG_DATA_<nonce>` 一致。
- 原有 system 在前，新增数据指令也是 system；历史保留、原始议题最后。
- citations 包含 documentId/ordinal，长文本截断为 200 字加省略号，短文本保留。
- 精确预算只容纳一条证据时删除相关性较低的条目；只能容纳原消息时退回空 citations。
- worker READY 快照含过期文档，mock retrieve 返回两个新 hits；验证检索参数、调用次数、实际 provider 消息及收尾引用。
- worker 检索抛错仍 SUCCEEDED，原议题不丢失，无 run.failed。
- 协作每 run 只检索一次，两席位各收到一个含两条证据的同 nonce 数据块，议题最后，汇总消息 citations 为 []。
- 协作检索异常或一直不返回时，10 秒内正常完成、双席位执行、无失败/降级事件或 degraded=true 写入。
- 异常/超时测试显式断言 retrieve 确实调用，防止基线完全不检索却假绿。

## 命令与结果

从仓库根目录执行：

1. `corepack pnpm install --frozen-lockfile --offline`：成功，复用本机缓存，未修改依赖声明或 lockfile。
2. `corepack pnpm exec vitest run packages/rag/test/inject.test.ts`：退出 1，预期红；缺少 `packages/rag/src/inject.ts`，一个 suite 收集失败。
3. `corepack pnpm exec vitest run --config apps/worker/test/rag.vitest.config.ts`：退出 1，预期红；2 个文件共 5 个测试失败，原因是实际消息无 RAG、citations 为空、retrieve 调用次数为 0。成功状态和正常产出断言先通过，未出现 DB/provider 桩错误。
4. `corepack pnpm exec vitest run --exclude packages/rag/test/inject.test.ts`：既有 root 套件 44 文件通过、4 文件跳过；364 测试通过、34 跳过，无失败。
5. `corepack pnpm exec vitest run --config /tmp/a6-inject-reference.config.mjs`：退出 0，注入测试 3/3 通过。临时配置仅将 `../src/inject` alias 到现有 `apps/web/src/lib/rag-context.ts`，并将 `@aichat/db` alias 到导出空 prisma 的临时文件；用于确认预算/包装/引用断言符合待迁移的既有实现。没有修改源码，也不是 A3 集成后转绿的证据。
6. `git diff --check`、`git status --short`：检查补丁空白与改动边界。

root vitest include 不包含新增 worker 文件，直接用 root 配置加文件名不会执行它们；必须使用上面的独立配置。原 worker 配置强制专用真实测试库，因此未运行其 DB 集成套件。本轮验证不依赖测试数据库，也没有使用浏览器。

A3 尚未合入本工作树；实际共享模块与 worker/collab 的绿测应在 A3 合入后重跑第 2、3 项。当前按简报保留真实红测，不跳过断言、不添加业务修复。

## 基线红测原始输出

### inject

```text

 RUN  v3.2.4 /home/codex/code/ai-chat-platform/wt-a6


 Test Files  1 failed (1)
      Tests  no tests
   Start at  15:42:01
   Duration  219ms (transform 37ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 77ms)


⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/rag/test/inject.test.ts [ packages/rag/test/inject.test.ts ]
Error: Cannot find module '../src/inject' imported from '/home/codex/code/ai-chat-platform/wt-a6/packages/rag/test/inject.test.ts'
 ❯ packages/rag/test/inject.test.ts:2:1
      1| import { expect, it } from 'vitest';
      2| import { injectContext } from '../src/inject';
       | ^
      3| import type { ChatMessage } from '@aichat/providers';
      4| 

Caused by: Error: Failed to load url ../src/inject (resolved id: ../src/inject) in /home/codex/code/ai-chat-platform/wt-a6/packages/rag/test/inject.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/.pnpm/vite@7.3.6_@types+node@24.13.5_jiti@2.7.0_tsx@4.23.13_yaml@2.8.1/node_modules/vite/dist/node/chunks/config.js:22739:33

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

```

### worker / collab

```text

 RUN  v3.2.4 /home/codex/code/ai-chat-platform/wt-a6

 ❯ apps/worker/test/runner-rag.test.ts (2 tests | 2 failed) 11ms
   × refreshes snapshot hits, sends RAG before the original question and persists citations 10ms
     → expected false to be true // Object.is equality
     → expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

     → expected "spy" to be called with arguments: [ { data: ObjectContaining{…} } ]

Received: 

  1st spy call:

  [
    {
-     "data": ObjectContaining {
-       "citations": [
-         ObjectContaining {
-           "documentId": "doc-a",
-           "ordinal": 0,
-           "text": "先备份再部署。",
-         },
-         ObjectContaining {
-           "documentId": "doc-b",
-           "ordinal": 2,
-           "text": "失败时回滚。",
-         },
-       ],
+     "data": {
+       "citations": [],
+       "content": "正常回答",
+       "conversationId": "conversation",
        "status": "COMPLETE",
      },
    },
  ]


Number of calls: 1

   × continues to SUCCEEDED when retrieval rejects 1ms
     → expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

 ❯ apps/worker/test/collab-rag.test.ts (3 tests | 3 failed) 14ms
   × retrieves once and gives both seats one evidence block with the same nonce 10ms
     → expected [] to have a length of 1 but got +0
   × retrieval exceptions do not fail or degrade collaboration 2ms
     → expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

   × a hanging retrieval times out within 10 seconds without degradation 2ms
     → expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0


 Test Files  2 failed (2)
      Tests  5 failed (5)
   Start at  15:42:01
   Duration  357ms (transform 163ms, setup 0ms, collect 250ms, tests 26ms, environment 0ms, prepare 136ms)


⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  apps/worker/test/collab-rag.test.ts > retrieves once and gives both seats one evidence block with the same nonce
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ apps/worker/test/collab-rag.test.ts:38:20
     36|     expect(messages.at(-1)).toEqual({ role: 'user', content });
     37|     const blocks = messages.filter(m => m.role === 'user' && /^RAG_DAT…
     38|     expect(blocks).toHaveLength(1);
       |                    ^
     39|     const nonce = /^RAG_DATA_([^\n]+)\n/.exec(blocks[0]!.content)![1];
     40|     expect(blocks[0]!.content).toContain(`END_RAG_DATA_${nonce}`);
 ❯ apps/worker/test/collab-rag.test.ts:35:41

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/7]⎯

 FAIL  apps/worker/test/collab-rag.test.ts > retrieval exceptions do not fail or degrade collaboration
AssertionError: expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

 ❯ apps/worker/test/collab-rag.test.ts:53:20
     51|   await processCollabRun('run', 'worker', fake);
     52|   expectCompleted();
     53|   expect(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversat…
       |                    ^
     54| });
     55| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/7]⎯

 FAIL  apps/worker/test/collab-rag.test.ts > a hanging retrieval times out within 10 seconds without degradation
AssertionError: expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

 ❯ apps/worker/test/collab-rag.test.ts:65:20
     63|   await running;
     64|   expectCompleted();
     65|   expect(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conversat…
       |                    ^
     66| });
     67| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/7]⎯

 FAIL  apps/worker/test/runner-rag.test.ts > refreshes snapshot hits, sends RAG before the original question and persists citations
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ apps/worker/test/runner-rag.test.ts:19:86
     17|   const messages = fake.stream.mock.calls[0]![0];
     18|   expect(messages.at(-1)).toEqual({ role: 'user', content });
     19|   expect.soft(messages.some(m => m.role === 'user' && /^RAG_DATA_/.tes…
       |                                                                                      ^
     20|   expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conv…
     21|   expect(db.message.create).toHaveBeenCalledWith({ data: expect.object…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/7]⎯

 FAIL  apps/worker/test/runner-rag.test.ts > refreshes snapshot hits, sends RAG before the original question and persists citations
AssertionError: expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

 ❯ apps/worker/test/runner-rag.test.ts:20:25
     18|   expect(messages.at(-1)).toEqual({ role: 'user', content });
     19|   expect.soft(messages.some(m => m.role === 'user' && /^RAG_DATA_/.tes…
     20|   expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conv…
       |                         ^
     21|   expect(db.message.create).toHaveBeenCalledWith({ data: expect.object…
     22|     status: 'COMPLETE', citations: hits.map(hit => expect.objectContai…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/7]⎯

 FAIL  apps/worker/test/runner-rag.test.ts > refreshes snapshot hits, sends RAG before the original question and persists citations
AssertionError: expected "spy" to be called with arguments: [ { data: ObjectContaining{…} } ]

Received: 

  1st spy call:

  [
    {
-     "data": ObjectContaining {
-       "citations": [
-         ObjectContaining {
-           "documentId": "doc-a",
-           "ordinal": 0,
-           "text": "先备份再部署。",
-         },
-         ObjectContaining {
-           "documentId": "doc-b",
-           "ordinal": 2,
-           "text": "失败时回滚。",
-         },
-       ],
+     "data": {
+       "citations": [],
+       "content": "正常回答",
+       "conversationId": "conversation",
        "status": "COMPLETE",
      },
    },
  ]


Number of calls: 1

 ❯ apps/worker/test/runner-rag.test.ts:21:29
     19|   expect.soft(messages.some(m => m.role === 'user' && /^RAG_DATA_/.tes…
     20|   expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conv…
     21|   expect(db.message.create).toHaveBeenCalledWith({ data: expect.object…
       |                             ^
     22|     status: 'COMPLETE', citations: hits.map(hit => expect.objectContai…
     23|       documentId: hit.documentId, ordinal: hit.ordinal, text: hit.text,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/7]⎯

 FAIL  apps/worker/test/runner-rag.test.ts > continues to SUCCEEDED when retrieval rejects
AssertionError: expected "spy" to be called once with arguments: [ 'owner', 'conversation', …(1) ]

Number of calls: 0

 ❯ apps/worker/test/runner-rag.test.ts:35:25
     33|   expect(events()).not.toContain('run.failed');
     34|   // Prevent a false green when the baseline never attempts retrieval.
     35|   expect.soft(retrieve).toHaveBeenCalledExactlyOnceWith('owner', 'conv…
       |                         ^
     36| });
     37| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/7]⎯

```

## 既有套件输出摘要

```text

 Test Files  44 passed | 4 skipped (48)
      Tests  364 passed | 34 skipped (398)
   Start at  15:40:52
   Duration  2.03s (transform 3.91s, setup 0ms, collect 10.91s, tests 2.01s, environment 7ms, prepare 4.34s)

```
