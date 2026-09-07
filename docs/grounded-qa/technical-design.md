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

2026-09-08执行器接线：index-runtime把source、provider、reserve、complete/fail/cancel接入index-executor；document-index-worker.ts与Compose index-worker profile独立于Deep，两个DOC_INDEX开关默认false，缺失/过期provider policy在认领前停止。运行阶段20秒heartbeat、15分钟索引任务取消预算（不改变Deep180秒），SDKembedding显式maxRetries=0/maxParallelCalls=1，每批≤32并校验返回用量；价格用BigInt上取整按逐输入请求保守预算，不能把占用当实际账单。policy须由运营核验profileKey、token上界/余量、请求费及价格依据与到期时间，不能由浏览器自报。Markdown保留BOM/CRLF原文offset；PDF/DOCX/CSV复用已有提取文本，manifest可声明extracted_text_v1，位置不得冒充源文件字节。source/prepare/complete/publish只接受ready原文记录。假provider链路、真实SDK+假EmbeddingModel、503零重试、缺usage拒绝、源适配测试通过；关闭开关CLI冒烟退出0，未启动容器或连接真实provider。Hybrid、API/UI和实际PG/provider验证仍待完成。

2026-09-08状态机节点：index-jobs/index-job-policy增加单活跃任务claim、60秒lease、heartbeat、取消与失败收尾、调用前generation总预算预占。未占额度的过期任务最多3次认领，占用后过期按model_outcome_unknown失败且不重发；cancel/failed不退还占用。现有consumed_input_tokens/consumed_cost_microusd在索引任务中表示保守预算占用上界，并非provider实际账单，后续UI必须使用“预算占用”标识，实际计费另行核对。短事务统一先slot锁，预算与代际累计原子核验；锁等待后重新检查lease和审批期限。当前只有存储函数和mock/SQL构造测试，未接实际Worker、未验证真实PG并发或执行embedding。

复用现有Deep Job的claim/lease/heartbeat/cancel/最终写入事务，capability snapshot改为逐source记录，可向后读旧snapshot但新任务写新版本。Deep走同一检索服务，最多6查询/12窗口，180秒总deadline，模型输出硬上限与maxRetries=0保持。任务恢复要核对累计已消费调用/费用，调用结果不确定不得自动重发。

索引和Deep使用独立任务表/开关，首期各一个活跃任务，公平调度与独立资源预算；索引开启不隐式开启Deep。新增POST /api/doc-library/index/status、/build、/cancel：user会话鉴权、归属检查、幂等键和范围白名单；build先预检/报价，不能由普通页面加载触发收费。语义模型或迁移缺失返回明确未就绪状态，词法路径继续可用。

沿用Deep start/status/cancel。source-catalog扩展关键词/语义就绪状态和当前版本；不返回连接配置。消息/SSE增加grounding状态、执行模式、候选/已读/引用计数、受控降级码与安全引用。无新字段的历史消息显示历史状态未知，不补写成“已检索”。

## 6. 诊断、安全与发布

2026-09-08引用窗口节点：新增POST /api/doc-library/index/read-citation，登录后严格接收library/document/generation/passage/hash，复用8秒只读版本/归属/hash核验，仅返回标题、≤4000字符窗口与核心偏移，不返回完整数据库行。新版href携带contentHash，DocumentCitationPanel在原查看器上方按偏移标记命中（重复文字不靠首次匹配）；缺参数、版本失效或读取失败明确提示。原文件仍可独立查看，当前只高亮经过校验的证据窗口，不宣称PDF坐标或原始Markdown全篇已经滚动定位。查看器增加库/文档身份及迟到请求校验，关闭清除引用参数。合成浏览器验证正常高亮/原文预览和错误hash提示；没有实际PG或生产引用验收。此前“URL未消费”的缺口已接线，旧无hash引用仍只能打开原文。

2026-09-08文档来源身份节点：PublicEvidence与客户端响应/视图新增documentId，实时reducer不再丢弃来源名称、作者及查询时间。前端按documentId归并来源，旧本站相对文档路由可回退解析身份，原始generation/passage URL与各片段仍独立保留；来源面板区分文档数和片段数。合成契约测试比较同一PublicEvidence经过实时reducer和历史hydrate后的结果，并验证两个位置共享编号、不同文档/外站不误并。本节点没有实现原文锚点高亮，也不是实际数据库历史恢复验收；原文查看器目前只消费documentId，generation/passage读取与高亮仍待接线。

2026-09-08确认UI节点：DocumentIndexActions沿用现有Dialog/Checkbox，用户点“生成预估”后才读取报价；显示范围、模型、输入/费用上界和两个截止时间，勾选后才创建任务。构建与激活独立确认，激活绑定打开时的版本。关闭中止报价，迟到响应丢弃；提交中防重复，失败清除确认且不自动重试；非法日期拒绝、确认计时上限15分钟。下方历史节点提到的确认入口缺口已补齐。浏览器仅用纯内存demo合成资料完成桌面全流程与console检查，不证明实际PG、费用、Worker或向量构建；限域canary仍需审批。

2026-09-08签名报价接口节点：新增quote/build/activate路由及客户端方法。报价读取整库ready源并确定性计算上界，不构造SDK或调用模型；HMAC用既有SESSION_SECRET及独立用途前缀，绑定user/library/manifest/profile/policyHash/预算/时限，令牌不含正文或凭据。确认窗口最多15分钟，执行授权最多24小时且不越过policy到期；免费策略也使用最小1微美元保守授权上限，不代表收费。build需confirm=true并验证当前profile/policy未变、整库文档集合仍匹配；重复请求沿用既有代际，不重置原审批。activate独立确认并只用服务端核验档案。policy新增credentialFingerprint（凭证ID/更新时间的hash），轮换后必须重新核验价格；可通过只读getDocumentIndexVerificationDescriptor获得配置描述，不返回凭据。假源报价、篡改/过期/跨用户/模型变化及HTTP门测试已通过，无真实生产报价或模型任务。确认UI、限域canary执行与实际费用验证仍待接线/审批。

2026-09-08状态入口节点：新增POST /api/doc-library/index/status和/cancel及客户端类型/API，状态仅返回进度、安全错误码和版本标识；关闭flags不读取索引表，不调用provider/原文。latest构建状态与currentReady分离，ready但未激活显示待核验启用；Worker configured不是进程健康。取消校验Origin/用户归属、支持重复请求，失败先确认取消避免误报；每个文档完成后更新实际进度。DocLibraryBrowsePage标题下新增紧凑状态行，独立请求10秒超时、切库/卸载取消、可刷新和停止构建，未加无后端支持的构建按钮。真实组件的本地mock页桌面/390px验证、刷新与返回导航、console无错误/无横向溢出通过；只验证了disabled演示状态，真实构建/取消和生产未执行。预览页已关闭、视口复原、5179服务已停止。quote/build/activate和引用恢复仍待接线。

2026-09-08代际检索节点：index-retrieval已接source adapter；完整current manifest与库内ready文档集合/版本一致才使用索引，新增/修改导致不一致时整库回词法，避免漏新文档或混旧版本。中文tsvector词法+按模型档案分组的向量召回，经RRF及本地重排；内部沿用chunk_bm25枚举名，但实际SQL为ts_rank_cd，不宣称实现了BM25。DOC_HYBRID独立默认false，单组向量阶段≤2.5秒并预留至少2秒深读时间，语义失败保留词法与降级信息。不同空间按各自排名融合，词法/语义各最多30候选；同组选定文档库合批，不逐库重复query embedding。新source.read使用generation/passage/hash完整锚点，退休版本可按固定版本回读但原文变化拒绝；同一文档多片段独立证据共享来源编号。ReadBudget改为只读repeatable-read；旧API补libraryIds限制。policy支持最多20个不同档案并拒绝重复价格键。这里是离线mock/SQL构造验证，真实PG执行计划/向量索引性能、外部reranker、引用UI/历史恢复与全链路成本计数仍待验证。

2026-09-08完成/发布存储节点：index-complete完成源hash、文档版本、模型档案与manifest一致性、向量数量/维度/float32/非零校验；50片段一批绑定参数写入同一事务，job完成和generation ready同事务。ready不自动current；独立activate重新核对所有任务、文档版本、片段覆盖与向量，再先退休旧current、后激活新current。代码支持同库retired版本经同样校验重新激活，不跳过变更检测。只有mock/SQL参数及数值测试已验证，尚无实际Postgres写入/回滚证明，未运行模型或切换生产。

先核对真实Run，记录目标轮次是否有工具与Evidence，不提交原始对话/查询正文。新日志只记录阶段、数量、query hash、generation、耗时桶和错误码。检索缓存不得跨用户；GeneOps正文仅请求内存，最终回答按现有会话规则保存。

按[需求评测](requirements.md)运行60题和安全/异常回归；先离线迁移/合成数据，再独立授权小样本和Staging。生产前核验源码、镜像、备份、flags、worker和现有配置；保留旧镜像、旧索引。异常优先关闭新增语义/Deep并切旧generation，必要时恢复旧镜像；不做破坏性down。每个阶段提交推送且核验远程SHA，未完成不合并/发布。
