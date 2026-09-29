# A5 RAG 预算回归测试结果

按简报完成测试交付；本工作树未合入 A2，实现仍为 3 秒，因此新增 6 项断言全部按预期为红。未修改任何 src、配置、依赖声明或锁文件。报告放在 `packages/rag/test/result.md`，遵守仅修改两个 test 目录的硬约束。

## 新增测试文件

- `packages/rag/test/budget.test.ts`：4 项断言。
- `apps/web/test/rag-context-budget.test.mts`：2 项断言。
- `apps/web/test/rag-context-budget.test.ts`：收集入口，导入上述 `.mts`；现有 web 配置只收集 `.ts/.tsx`，无需改动目录外配置。

## 覆盖点

1. 包公共入口 `@aichat/rag` 导出 `RETRIEVAL_BUDGET_MS === 8_000`。使用命名空间读取，基线缺失导出表现为断言失败，而非收集失败。
2. retrieve 源码的 deadline 引用统一常量 `Date.now() + RETRIEVAL_BUDGET_MS`。
3. retrieve 在 embed 一直未完成时，7999ms 仍等待，8000ms 返回 `RAG_TIMEOUT`，不执行查询。
4. embed 虚拟耗时 4000ms 后，retrieve 仍能返回 hits。
5. rag-context 外层在 retrieve 一直未完成时，7999ms 仍等待，8000ms 降级为 `RAG_UNAVAILABLE`。
6. 模拟慢 embed 导致 retrieve 虚拟耗时 4000ms，retrieveContext 应返回 `READY` 且包含预期 hits。

所有新增延时均由 fake timers 推进，无真实 4/8 秒等待。mock 位于被测模块所在包内；web 保留 rag 真实导出，仅替换 retrieve，因此不会用假的预算常量遮蔽问题。内部测试替换原生 AbortSignal.timeout（它不受 Vitest 虚拟时钟控制），验证 retrieve 自身 deadline race。失败处理器在推进时钟前注册；每项测试清理虚拟计时器，恢复时钟及环境。

## 执行命令与结果

均从仓库根目录执行。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 环境无 pnpm，退出 127 |
| `npx --yes pnpm@10.34.5 install --frozen-lockfile --offline` | 退出 0；按原锁文件离线安装已有依赖，未新增依赖 |
| `node node_modules/vitest/vitest.mjs run packages/rag/test/budget.test.ts --reporter=verbose` | 4 项预期失败；初版输出后将源码断言报错缩短，最终全套复验见下 |
| `node node_modules/vitest/vitest.mjs run --config apps/web/vitest.config.ts test/rag-context-budget.test.ts --reporter=verbose` | 2 项预期失败 |
| `node node_modules/vitest/vitest.mjs run --exclude packages/rag/test/budget.test.ts` | 退出 0；44 文件通过、4 跳过；364 项通过、34 跳过 |
| `node node_modules/vitest/vitest.mjs run --config apps/web/vitest.config.ts --exclude '**/rag-context-budget.test.ts'` | 退出 0；15 文件、150 项通过 |
| `node node_modules/vitest/vitest.mjs run` | 退出 1；新增 4 项失败，既有 364 项通过、34 项跳过 |
| `node node_modules/vitest/vitest.mjs run --config apps/web/vitest.config.ts` | 退出 1；新增 2 项失败，既有 150 项全部通过 |
| `git diff --check` | 退出 0 |

包含新测试的全套运行确认了既有套件没有被 mock 或计时器污染。未运行浏览器或读取技能目录。未运行另行启动的集成测试及 `.mjs` 脚本。

当前未验证 A2 合并后的绿测，也未改写 src 来模拟修复。合并时需关注既有 `packages/rag/test/retrieve.test.ts` 中写死 2800ms/2100ms 的预算用例，以及独立 `apps/web/test/rag-chat.test.mjs` 中写死 3 秒的用例；它们可能需要随 A2 预算变化更新。

## 基线红测原始输出

以下为最终包含新旧测试的运行输出中的完整失败段与汇总。

### packages/rag

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/rag/test/budget.test.ts > exports RETRIEVAL_BUDGET_MS = 8000 from @aichat/rag
AssertionError: expected undefined to be 8000 // Object.is equality

- Expected: 
8000

+ Received: 
undefined

 ❯ packages/rag/test/budget.test.ts:36:51
     34| it('exports RETRIEVAL_BUDGET_MS = 8000 from @aichat/rag', () => {
     35|   // Namespace access keeps the pre-A2 missing export an assertion fai…
     36|   expect(Reflect.get(rag, 'RETRIEVAL_BUDGET_MS')).toBe(budget);
       |                                                   ^
     37| });
     38| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  packages/rag/test/budget.test.ts > derives retrieve deadline from the shared RETRIEVAL_BUDGET_MS constant
AssertionError: retrieve must derive its deadline from Date.now() + RETRIEVAL_BUDGET_MS: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ packages/rag/test/budget.test.ts:42:80
     40|   const source = readFileSync(new URL('../src/retrieve.ts', import.met…
     41|   expect(/Date\.now\(\)\s*\+\s*RETRIEVAL_BUDGET_MS\b/.test(source),
     42|     'retrieve must derive its deadline from Date.now() + RETRIEVAL_BUD…
       |                                                                                ^
     43| });
     44| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 FAIL  packages/rag/test/budget.test.ts > keeps a stalled embed pending through 7999ms and rejects at 8000ms
AssertionError: expected "spy" to not be called at all, but actually been called 1 times

Received: 

  1st spy call:

    Array [
      "RAG_TIMEOUT",
    ]


Number of calls: 1

 ❯ packages/rag/test/budget.test.ts:55:23
     53|   await vi.advanceTimersByTimeAsync(budget - 1);
     54|   expect(mocks.embed).toHaveBeenCalledTimes(1);
     55|   expect(settled).not.toHaveBeenCalled();
       |                       ^
     56|   await vi.advanceTimersByTimeAsync(1);
     57|   expect(await pending).toEqual(new Error('RAG_TIMEOUT'));

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/4]⎯

 FAIL  packages/rag/test/budget.test.ts > returns hits when embed takes 4000ms within the retrieval budget
AssertionError: expected Error: RAG_TIMEOUT to deeply equal [ { documentId: 'doc', …(4) } ]

- Expected: 
[
  {
    "distance": 0.1,
    "documentId": "doc",
    "name": "fact.txt",
    "ordinal": 0,
    "text": "The answer is 42",
  },
]

+ Received: 
Error {
  "message": "RAG_TIMEOUT",
}

 ❯ packages/rag/test/budget.test.ts:68:25
     66|   const pending = rag.retrieve('owner', 'conversation', 'query').catch…
     67|   await vi.advanceTimersByTimeAsync(4_000);
     68|   expect(await pending).toEqual([hit]);
       |                         ^
     69|   expect(vi.getTimerCount()).toBe(0);
     70| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯


 Test Files  1 failed | 44 passed | 4 skipped (49)
      Tests  4 failed | 364 passed | 34 skipped (402)
   Start at  15:41:23
   Duration  1.94s (transform 4.22s, setup 0ms, collect 12.30s, tests 2.73s, environment 8ms, prepare 4.14s)
```

### apps/web

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/rag-context-budget.test.ts > keeps the outer deadline pending through 7999ms and degrades at 8000ms
AssertionError: expected "spy" to not be called at all, but actually been called 1 times

Received: 

  1st spy call:

    Array [
      Object {
        "hits": Array [],
        "status": "RAG_UNAVAILABLE",
      },
    ]


Number of calls: 1

 ❯ test/rag-context-budget.test.mts:34:23
     32|   await vi.advanceTimersByTimeAsync(7_999);
     33|   expect(mocks.retrieve).toHaveBeenCalledWith('owner', 'conversation',…
     34|   expect(settled).not.toHaveBeenCalled();
       |                       ^
     35|   await vi.advanceTimersByTimeAsync(1);
     36|   expect(await pending).toEqual({ status: 'RAG_UNAVAILABLE', hits: [] …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/rag-context-budget.test.ts > returns READY with hits when slow embedding makes retrieval take 4000ms
AssertionError: expected { status: 'RAG_UNAVAILABLE', hits: [] } to deeply equal { status: 'READY', hits: [ { …(5) } ] }

- Expected
+ Received

  {
-   "hits": [
-     {
-       "distance": 0.1,
-       "documentId": "doc",
-       "name": "fact.txt",
-       "ordinal": 0,
-       "text": "The answer is 42",
-     },
-   ],
-   "status": "READY",
+   "hits": [],
+   "status": "RAG_UNAVAILABLE",
  }

 ❯ test/rag-context-budget.test.mts:48:25
     46|   expect(mocks.retrieve).toHaveBeenCalledWith('owner', 'conversation',…
     47|   await vi.advanceTimersByTimeAsync(4_000);
     48|   expect(await pending).toEqual({ status: 'READY', hits: [hit] });
       |                         ^
     49|   expect(vi.getTimerCount()).toBe(0);
     50| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed | 15 passed (16)
      Tests  2 failed | 150 passed (152)
   Start at  15:41:23
   Duration  1.04s (transform 2.73s, setup 0ms, collect 4.51s, tests 624ms, environment 7ms, prepare 2.17s)
```
