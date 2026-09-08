# 60题词法组件实验（不是MVP验收）

使用 `bun run --cwd apps/web ./scripts/probe-grounded-lexical.ts` 复现。脚本只使用固定合成语料与内存SQLite，不读取用户资料/配置或连接网络。生产旧关键词检索与实验共享documentLexicalExpressions，分片使用实际buildDocumentPassages；实验不包含生产ORM联表、权限路径、旧上传分片、PostgreSQL tsvector/向量、RRF、改写、历史理解、生成或Deep。因此不能叫作完整旧版或新版产品基线。

2026-09-08本机两次执行完成，19份虚构文档、15083片段、60题，排除耗时后结果完全一致。[首轮原始安全报告](lexical-component-probe-v1.json)记录每题候选ID和计数。terms/late_passage/synthesis以及followup中有期望证据的题目macro Recall@20均为1.0；temporal为0.8，time-4预期两段均未召回。无答案missing-5仍返回1个候选。time-3/time-4需要不足或冲突提示，召回成功本身也不构成可以断言结论的理由。

标签为工程初稿，非人工Gold；大部分题目限定一到两个文档，语义题含有字面重合，故高召回不能证明跨库中文语义质量。没有期望正文的题目Recall为null而不是1；报告未计算答案或引用precision。SQLite耗时仅诊断用，不能外推生产P95。所有片段正文只在进程内，数据库在finally关闭。

下一步：保留失败样例，不改标签迎合结果；优先验证无答案/冲突时的充分性判断，再在获授权的真实运行路径上补完整基线与人工支持度。当前报告不允许提交到qa:eval作为正式通过报告。
