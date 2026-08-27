# Petrichor GeneOps 双速检索与异步深度任务设计

状态：设计已完成，尚未安装 Workflow DevKit、创建生产 Workflow、执行 migration 或部署。

## 结论

快速回答继续使用现有同步 Agent Run；异步深度任务必须使用可恢复的 durable runtime。
当前 `afterResponse()` 只是 Bun 进程内 `queueMicrotask`，不能证明 Vercel Function 回收、
崩溃或重新部署后任务仍会继续，因此不得用它承载 1–3 分钟深度研究。

推荐 Vercel Workflow DevKit，但仓库当前没有 `workflow` / `@workflow/*` 运行包。
在确认 Hobby 计划可用性、费用和部署约束前，不新增生产依赖。

## 用户路径

1. 用户发送问题。
2. 同步 Run 只用当前 capability 允许的快速资料：
   - raw exact/fuzzy；
   - 只有 `quality_status` 达标后才可 hybrid。
3. 快速回答正常落在当前会话，不等待深度任务。
4. 路由器按复杂度、冲突/多来源信号和用户设置决定是否启动 deep Run。
5. deep Run 完成后在同一会话追加一条明确标记“深度检索补充”的回答；不得静默覆盖快速回答。
6. 失败、取消或能力降级以单独状态追加，不伪造旧快照结论。

现有页面与资料源选择器保持不变。

## Durable Workflow

Workflow 只做编排，所有外部 I/O 和 AI 调用放在可重试 step：

1. `captureCapabilities`
   - 固定本次 `quality_status_v1`、source cutoff、允许模式、Wiki/graph 版本。
   - 后续 step 不因运行中 capability 变化而静默扩大权限。
2. `buildRetrievalPlan`
   - 把原问题拆为有界 query set。
   - 不保存业务查询到 GeneOps audit；Petrichor Run 仍按现有会话策略保存用户问题。
3. `parallelRetrieve`
   - exact/fuzzy；质量达标才 semantic/hybrid。
   - 每种模式有单独超时、结果上限和 metadata-only Trace。
4. `deduplicateDocuments`
   - 先按真实 document ID 去重，再做跨模式 RRF。
   - 同一帖子多个 chunk 不能占满候选。
5. `anchoredRead`
   - 只深读检索返回的 document ID。
   - 原始 GeneOps chunks 只留在当前 step 输出，不进入 Trace/日志/长期数据库。
6. `optionalWikiGraph`
   - `wiki_ready=false` 时跳过 Wiki。
   - `graph_ready=false` 时跳过 Graph。
7. `synthesizeAndValidate`
   - 至少两个来源时做冲突与时效判断。
   - 引用必须对应当前 Run 的安全引用元数据。
8. `appendDeepAnswer`
   - 幂等追加到原 thread，保留快速回答。
   - 保存最终回答和安全来源链接，不保存原始 chunks/snippets。

## 幂等与状态

- Workflow idempotency key：
  `sha256(threadId + fastRunKey + sourceScopeHash + questionHash + contractSnapshotHash)`。
- 同一 key 只允许一个 active deep Run。
- deep Run 使用新的 `agentRuns.runKey`，通过 `retryOfRunKey` 或 metadata 关联快速 Run，
  不复用原 Run 的终态。
- 每个 step 输出必须可序列化并有 256 KiB 上限。
- 取消时停止后续 step；已完成 step 不反向修改 GeneOps。
- 最终追加消息使用独立 client request/idempotency key。
- Trace 继续沿用 GeneOps metadata-only 脱敏规则。

## 路由条件

默认自动启动 deep Run：

- 明确要求“深入研究、综合多个来源、对比、核验、找反例”。
- 同步检索出现来源冲突、低置信度或候选不足。
- 问题同时涉及两个以上资料源。
- 需要 semantic/hybrid 或 anchored multi-document read 才能回答。

默认不启动：

- 单一精确事实已由高置信 exact 命中回答。
- 仅选 GeneOps 且 GeneOps 不可用。
- capability/quality snapshot 过期。
- 用户关闭深度补充。

## 超时与预算

- 目标：1–3 分钟。
- 总 deadline：180 秒。
- query set：最多 6。
- 每模式每 query：最多 20 candidates。
- 去重后深读：最多 12 documents，每文档最多 12 chunks。
- 单步最多 3 次自动重试；权限、契约和校验错误为 fatal。
- 总模型调用和 token 上限沿用 Agent Run budget，并单独记录 deep Run。

## Feature Flags

- `PETRICHOR_DEEP_RESEARCH_ENABLED=false`
- `PETRICHOR_DEEP_RESEARCH_AUTO_START=false`
- `PETRICHOR_GENEOPS_HYBRID_ENABLED=false`
- `PETRICHOR_GENEOPS_WIKI_ENABLED=false`
- `PETRICHOR_GENEOPS_GRAPH_V2_ENABLED=false`

依赖顺序：raw hybrid → deep raw retrieval → Wiki → graph v2 → auto-start。

## 验收

- 快速回答先完成，deep Run 后追加且不覆盖。
- 页面刷新、函数重启和短暂网络失败后 deep Run 可恢复。
- 重复启动不产生重复消息。
- mixed scope 的 GeneOps 失败只降级外部来源；GeneOps-only 明确失败。
- Wiki/graph 未 ready 时没有对应工具调用。
- Trace、审计和 Vercel logs 不含 query/chunk/result 正文。
- 取消、超时和 fatal error 都产生可读终态。
- 生产观察 7 天后才考虑默认开启 auto-start。

## 实施前授权

需要用户确认：

1. Vercel Hobby 是否支持当前 Workflow DevKit，以及实际计费。
2. 是否允许新增并锁定 `workflow`、Vite integration 和对应运行配置。
3. 是否允许为 deep Run 增加必要的关联/幂等字段 migration。
4. 是否允许先在 Preview/mock 数据运行 Workflow integration tests，再部署 Production 且保持 flags off。
