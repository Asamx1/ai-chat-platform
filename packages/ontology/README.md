# @aichat/ontology

P0/M14 规则层：版本化 YAML、结构校验、注册表、有界显式推理与断言状态机。仅操作内存，不读写 Vault 或数据库。包版本与兄弟包一致为 `0.0.1`；没有跨 workspace 包依赖，后续消费者使用 `workspace:*`。运行目标为 Node ESM，入口 `src/index.ts`，默认本体通过相对 `import.meta.url` 读取，部署时必须保留 defaults。声明依赖 zod 4.1.5 和 yaml 2.8.1；本任务不安装依赖或修改 lockfile。

## 文件与 YAML 契约

- `defaults/ontology.yaml`：7 个 Class 的 id、label、description、abstract；关系的 id、label、domain、range、symmetric、transitive、requiresContext、description。简报的 9 组关系中 supports/contradicts 是两个独立 ID，因此共 10 个关系定义。Class、Entity、Evidence、Assertion、Experiment 是结构端点角色，不是新增领域 Class。实例按具体 Class 类型标记，类型节点用 Class；Evidence 是带定位的证据，Assertion 是具体断言 ID，Experiment 是评测记录。abstract 表示类能否实例化（默认七类均可）。
- `defaults/constraints.yaml`：断言必填字段列表、数值附加字段及端点/环/证据目标约束。object 与 value 必须且只能选一；origin 为 sourced 或 inferred。value 谓词是属性标识；object 谓词必须是注册关系，不把关系端点替换为数值。
- `defaults/inference-rules.yaml`：ruleId、ruleVersion、approved、description、premises、maxDepth 和禁止清单。premises 为说明性模式，绝不解释执行自然语言。默认深度 5，只有两条硬编码批准规则。没有 inverseOf 对，互逆规则默认空载；以后须双向声明并符合互换端点类型。

每份 YAML 的 `version` 是唯一 schemaVersion 标识（semver），不另设第二个 schemaVersion 字段；断言 ruleVersion 与 revision 分别记录规则版本和正整数修订版本。别名先核对 canonicalId，再核对类型及版本、定义及上下文，最后仅用相似度生成复核候选，不能直接合并。

## API

`loadOntology(text)`、`loadConstraints(text)`、`loadInferenceRules(text)` 解析 YAML 并用 Zod 校验；格式、重复键、未知规则及结构错误抛带字段明细的 SchemaLoadError。加载本体也检查重复 ID、未知端点类型和互逆声明一致性。

`createRegistry(ontology?)` 提供 getClass(id)、getRelation(id)、relationsFor(subjectType, objectType)。`checkRelationEdge(subjectType, relationId, objectType, ontology?)` 返回 Violation[]，默认使用随包本体。

`checkAssertion(a, ontology, constraints, existingAssertions?)` 返回结构化 `{code,path,message}` 违规数组，不因断言非法而抛错。包含必填、数值单位/数据集/设置/指标、端点、上下文、具体断言目标和 subclass_of 自环检查。检查跨记录的环时，调用者必须传入完整现有图（第四参数）；批量摄入应逐条检查并加入已通过记录。数值结果可用 `predicate: "accuracy", value: 0.9, unit: "ratio", dataset: "dataset-id", testSettings: {...}, metric: "accuracy"`。有效时间为 `{from: string|null, to: string|null}`，null 表示开放边界。证据项包含 sourceId、sourceVersion（版本或 hash）、locator、excerpt、relation；来源是否存在及语义支持由上层校验。

`runInference(assertions, rules, options?)` 返回 `{ assertions, derived, invalidateDerived }`；options 可传 ontology、maxDepth、maxRounds，默认轮数 5，边界必须为 1..100 整数。仅使用 supported、肯定、未撤回的原文断言；输入已有 inferred 记录不作为根，重算生成新的派生视图。subclass_of 仅拼接上下文和有效时间完全一致的边。深度按原始边数计算，互逆步骤增加 1；循环按语义端点、谓词、极性、上下文、有效时间去重。symmetric 元数据本身不授权反向推理。

每个输出保留 origin=inferred、ruleId、ruleVersion、直接 premiseAssertionIds、合并的 evidence 来源链和 depth。`result.invalidateDerived(premiseId)` 将该前提标记 withdrawn/invalid，递归标记所有依赖结论 invalid，并返回受影响下游断言；原始调用输入不被修改。有效视图必须过滤 invalid/superseded/withdrawn。同一事实只保留一条推导证书，任一被记录前提撤回即失效；如需寻找其他仍有效证明，再调用 `runInference(result.assertions, rules, options)` 全量重算。

`status.ts` 提供 legalTransitions、canTransition、transitionStatus。candidate 可到 supported/contested/superseded/invalid，supported 和 contested 可互转并转 superseded/invalid，superseded 仅到 invalid，invalid 终态；非法迁移抛错。重新发现失效事实应建立新修订，不能静默复活。

`types.ts` 是无运行时导入的纯契约模块，其他模块只以 type-only 方式引入其类型。tsconfig 继承根严格模式，包括 exactOptionalPropertyTypes。

## 规则变更

建议 → 用户确认版本 → 计算影响范围 → 暂存迁移并重算 → 校验 → 发布。失败保持旧版本可用，保存迁移记录；不自动更改关系语义，不自动合并别名。P0 不修改数据库或 Prisma schema。

本包借鉴 SHACL/SKOS/PROV-O 的形状、词表及来源设计，但不宣称兼容 W3C 标准，也不是完整 OWL 或 SHACL 引擎。相关不能推成因果，broader_than 不等于 subclass_of，“优于/使用”不能自动传递。

## 验证

`test/ontology.test.ts` 覆盖 YAML 错误、元数据完整性、端点和数值字段、成环拒绝、深度及轮数、撤回传播、有限规则边界、互逆声明、状态迁移；根 vitest.config.ts 显式列入此测试。交付阶段未运行构建、类型检查或测试；由编排方安装解析器依赖、更新锁文件并执行完整验证。
