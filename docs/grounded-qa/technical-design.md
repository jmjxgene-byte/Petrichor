# 可信资料问答 MVP 技术设计

日期：2026-09-08。本文件描述待实现契约，不表示迁移、模型调用或部署已执行。

## 基线与参考

开发基线 b6eac4c729658c04655edc535367f4c7c51c6189；远端回滚 tag baseline/pre-grounded-qa-20260908。应用代码与此前部署0344a485f一致，差异仅台账/部署文档；生产当前身份仍需发布前实时核验。

参考 WeKnora 固定647848f3954dae34473b8a8d0e0eef5e0fb3a58e的[问答编排](https://github.com/Tencent/WeKnora/blob/647848f3954dae34473b8a8d0e0eef5e0fb3a58e/internal/application/service/session_knowledge_qa.go)、[邻近扩展](https://github.com/Tencent/WeKnora/blob/647848f3954dae34473b8a8d0e0eef5e0fb3a58e/internal/application/service/chat_pipeline/merge_expand.go)、[重排与多样性](https://github.com/Tencent/WeKnora/blob/647848f3954dae34473b8a8d0e0eef5e0fb3a58e/internal/agent/tools/knowledge_search.go)。只借鉴机制，使用项目现有TypeScript模块；不复制正文日志和可跳过资料约束的策略。若后续移植实际代码，保留许可证归属并单独审查依赖。

## 1. 编排与限额

在现有Runtime中以grounding policy取代短问正则决定是否预检索，复用统一ToolExecutor及source adapters。既有普通Agent与写操作保持确认规则，不能通过其他工具绕过选定范围。历史无scope仍按local，不重写历史消息。

固定流程：resolve scope/auth→normalize question→search→RRF/rerank→anchored read→evidence gate→answer。原问题始终保留；规则处理语气词与中文词元，补检/模糊追问最多一次有schema校验的模型计划，最多3个变体。计划不能修改范围或替用户选择歧义。快路径最多2轮、60候选、20重排候选、6个证据窗口，共享8秒预算；每个下游调用使用剩余deadline并支持abort，不能仅Promise.race而遗留后台查询。用参数化SQL和statement timeout约束查询。

复用server/retrieval的tokenize/query-rewrite/fusion/reranker。召回列表按候选身份先去重，同一召回列表中重复项不得重复累加RRF；稳定ID作为同分tie-break。不按文档过早合并，优先相关性并避免重复片段挤占预算，不以固定来源数量作为充分性。

零证据、来源全部失败、关键歧义分别进入不足/不可用/澄清分支，禁止通用业务补全。有证据时生成只引用本轮合法证据的回答；引用注册表校验与语义支持评测分开，不能承诺格式校验能消除幻觉。流式UI只播报真实阶段，不显示内部推理；未通过证据门不启动业务结论生成。

## 2. 阅读契约与引用

SourceCandidate保持现有sourceRef/kind/title，新增文档片段身份、generationId、contentHash、anchor及检索模式元数据。SourceReadInput的document分支扩展chunkId/passageId；新候选必须携带锚点，legacy无锚点仅用于明确顺序阅读，不假装精确命中。

阅读先校验user/library/document/片段归属和版本，再围绕命中扩展；单窗口父上下文≤4000字符，先保留核心命中、再分配邻近预算。旧chunk本身≤4000，不能先clip文档开头。引用去重身份用source+generation+passage，引用分组使用document，二者分离。安全引用保存定位/hash/标题/URL/时间状态；打开原文时重新鉴权，旧generation失效明确提示，不跳转到新版本同序号冒充原位置。

GeneOps只调用已批准安全RPC并逐源检查contract/quality。v1不具备锚点能力时声明限制；不得伪造锚点或绕过到public大表。不同generation不在同一来源本轮回答中混用，restricted/removed读取时实时复核。

## 3. 派生索引与迁移

2026-09-08实现节点：新增docIndexGenerations/docPassages/docIndexJobs及2026-09-08-document-retrieval-index.sql，初始化和增量DDL镜像一致；复合FK约束用户/库/文档/代际，current仅允许ready且完成计数匹配，同库唯一current。用户明确删除文档/库时派生行级联清理，非回滚删除；旧chunk与对象保持原路径。必须通过现有bun db:migrate的migrator事务应用，其末尾启用RLS/撤销公开角色并授予runtime CRUD，不支持绕过runner直接执行SQL。12项内存SQLite约束已验证，Postgres/RLS/vector仍待离线实际验证；无索引任务或模型已运行。

新增三类表：文档索引generation（library/manifest/current状态/模型档案）、passage（generation/document/锚点/父范围/正文/词元/向量/hash）、index job（document/generation/状态/进度/租约/错误码/安全预算）。具体DDL与manifest按项目迁移流程生成，离线验证后独立批准生产应用；既有migration不可修改，构建期不得迁移。

一份原文件一个原documentId不变，从受限S3读取原文重建派生索引；保留旧docChunks与旧generation。parent目标≤4000字符，child目标768字符/重叠80，同时按provider token限制；尊重章节、可识别消息及代码块，不推断关系和时间。片段保存可复核原文范围和hash。新generation按固定输入manifest完成计数/hash/孤儿/向量档案验证后，事务切换current；输入变化停止切换，不覆盖旧版本。

仅Petrichor本地资料进入派生passage，不镜像GeneOps。新增表继承现有migrator/runtime分离、RLS及匿名角色撤权策略；runtime不可DDL。读取始终带user及范围过滤，索引入口不得借管理员身份扩大可见范围。

## 4. 向量与模型

2026-09-08分片/准备节点：passage-builder保留未归一化原文UTF-16位置与UTF-8 hash，frontmatter排除检索，代码/表格原子保护；识别大量带绝对日期文本的二级消息标题时打包完整短消息，不把每条消息标题当独立章节；未确认时区故publishedAt仍null，不推断时间。19篇原文件离线检查全部通过，共17733候选片段，不代表embedding已完成。index-contract/index-store固定manifest和模型档案、校验审批绑定与版本、库归属、重复请求与审批复用；准备仅建队列，不调用S3/模型或切current。审批额度是整generation共享总额，后续执行器需累计汇总，不能按每个job单独重复额度；真实token上限/计费/claim/发布仍待实现验收。

复用EMBEDDING用途绑定，先独立验证真实embedding和rerank支持。档案包含provider/model身份、维度、模型版本与预处理版本；不同空间分别生成查询向量并检索，排名级融合。档案变化构建新generation，不能自动把旧向量解释为新空间。索引DDL由迁移角色受控执行，不复用会在运行请求中自动建索引的路径。

中文词法采用项目词元与Postgres检索，语义采用pgvector；查询阶段先过滤用户/范围/current/档案，ANN结果必须复核。维度相关索引在模型档案核验后通过受控迁移创建。外部重排只传限量候选片段，失败降级本地；语义失败降级词法，并返回真实模式/原因。本地Hybrid开关独立于GeneOps Hybrid，后者沿用既有质量门与BGE-M3空间约束。

任何实际批处理先提交样本、片段、token、服务目标、价格来源、费用上限、并发和停止条件。没有批准不发业务模型请求；未核实费用不启动。新模块不修改其他生成路径的默认值。

## 5. Worker与API

2026-09-08状态机节点：index-jobs/index-job-policy增加单活跃任务claim、60秒lease、heartbeat、取消与失败收尾、调用前generation总预算预占。未占额度的过期任务最多3次认领，占用后过期按model_outcome_unknown失败且不重发；cancel/failed不退还占用。现有consumed_input_tokens/consumed_cost_microusd在索引任务中表示保守预算占用上界，并非provider实际账单，后续UI必须使用“预算占用”标识，实际计费另行核对。短事务统一先slot锁，预算与代际累计原子核验；锁等待后重新检查lease和审批期限。当前只有存储函数和mock/SQL构造测试，未接实际Worker、未验证真实PG并发或执行embedding。

复用现有Deep Job的claim/lease/heartbeat/cancel/最终写入事务，capability snapshot改为逐source记录，可向后读旧snapshot但新任务写新版本。Deep走同一检索服务，最多6查询/12窗口，180秒总deadline，模型输出硬上限与maxRetries=0保持。任务恢复要核对累计已消费调用/费用，调用结果不确定不得自动重发。

索引和Deep使用独立任务表/开关，首期各一个活跃任务，公平调度与独立资源预算；索引开启不隐式开启Deep。新增POST /api/doc-library/index/status、/build、/cancel：user会话鉴权、归属检查、幂等键和范围白名单；build先预检/报价，不能由普通页面加载触发收费。语义模型或迁移缺失返回明确未就绪状态，词法路径继续可用。

沿用Deep start/status/cancel。source-catalog扩展关键词/语义就绪状态和当前版本；不返回连接配置。消息/SSE增加grounding状态、执行模式、候选/已读/引用计数、受控降级码与安全引用。无新字段的历史消息显示历史状态未知，不补写成“已检索”。

## 6. 诊断、安全与发布

2026-09-08完成/发布存储节点：index-complete完成源hash、文档版本、模型档案与manifest一致性、向量数量/维度/float32/非零校验；50片段一批绑定参数写入同一事务，job完成和generation ready同事务。ready不自动current；独立activate重新核对所有任务、文档版本、片段覆盖与向量，再先退休旧current、后激活新current。代码支持同库retired版本经同样校验重新激活，不跳过变更检测。只有mock/SQL参数及数值测试已验证，尚无实际Postgres写入/回滚证明，未运行模型或切换生产。

先核对真实Run，记录目标轮次是否有工具与Evidence，不提交原始对话/查询正文。新日志只记录阶段、数量、query hash、generation、耗时桶和错误码。检索缓存不得跨用户；GeneOps正文仅请求内存，最终回答按现有会话规则保存。

按[需求评测](requirements.md)运行60题和安全/异常回归；先离线迁移/合成数据，再独立授权小样本和Staging。生产前核验源码、镜像、备份、flags、worker和现有配置；保留旧镜像、旧索引。异常优先关闭新增语义/Deep并切旧generation，必要时恢复旧镜像；不做破坏性down。每个阶段提交推送且核验远程SHA，未完成不合并/发布。
