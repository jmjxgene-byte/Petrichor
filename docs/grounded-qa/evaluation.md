# 可信问答离线评测报告

运行 `bun run qa:eval /path/to/restricted-report.json`；这是本地报告校验，不会访问数据库、来源或模型。退出码0表示这份报告的检索指标门通过，1表示未通过，2表示输入无效；任何结果都不等于整个MVP可以发布。

输入结构以 `apps/web/src/server/retrieval/grounded-evaluation.ts` 的严格schema为准。只接收元数据：冻结datasetSha、相同题集的baselineDatasetSha、60条逐题记录，不接收query、answer、正文或原始RPC。私有题目和人工标注材料留在受限环境，报告保留证据身份用于本地对账；stdout仅输出聚合分数与安全原因码。

题目分组固定为terms 15、late_passage 15、synthesis 10、followup 10、no_answer 5、temporal 5。每题绑定人工相关证据expectedEvidenceIds、期望的answer/clarify/insufficient和真实运行结果；semantic标签在测试前冻结，不能看结果后挑子集。retrievedIds保持原始排名，readIds只记录实际深读过的证据，baselineRetrievedIds来自旧版本同题集的实际运行；不允许用搜索结果冒充深读。

reviewer必须由人工审查材料核实为human；claims/ reviewedClaims/ supportedClaims分别是事实性结论—引用关系总数、已审核数、被资料支持数。合法引用编号不是支持判断，模型自评不能替代人工。评测器无法认证审查者身份或判断输入是否伪造，验收负责人仍须查阅原始运行证据、冻结题集和人工复核材料；单独填入human并不构成证明。

Recall@20按有答案题逐题计算后宏平均，重复命中只算一次且不回补第21名；语义子集须优于基线，术语题逐题不退化。人工支持precision使用全部结论关系作分母，缺审核则不提供通过分数。文末题必须有gold证据进入readIds。每题标明是否预期经过本地检索localExpected，localMs只统计该子集，缺测不能以0代替；P95采用nearest-rank。fastMs不得超过8000。记录retrievalRecorded、unsafeResults、unknownTimeAssertions，分别对应实际执行留痕、越权/限制内容泄漏和未知时间确定性断言。

## 合成题集v1

有限canary仅规划入口及实测规模见[canary-plan-only.md](canary-plan-only.md)。使用 `bun run --cwd apps/web ./scripts/plan-grounded-canary.ts --review-template` 输出60题人工待审阅草稿；所有实际运行/答案/引用审查字段均为空，不可直接作为通过报告。

`apps/web/src/server/retrieval/fixtures/grounded-qa-v1.ts`包含19份虚构资料和60题，序列化dataset SHA为`55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e`。此版本供回归，变更需另建版本；不是实际业务题或人工独立审核结果。每题明确scope、history、expectedResolution、证据文档及原文quote，语义标签在运行前固定。文末题位于1000段过程记录之后，真实切片器输出中的命中索引必须大于20。测试证明引文属于范围且仍可切片定位，不证明检索能命中。

运行旧/新检索前，需将每条quote映射到对应冻结generation中的实际证据ID，执行检索并记录实际readIds；不能把期望quote直接当检索结果。人工仍需独立检查题目歧义和期望关系，尤其时间冲突和澄清题。当前尚无旧/新检索实跑、真实群聊60题或人工支持标注；不得报告业务Recall/precision已达标。另需验收Deep 180秒、队列/取消/崩溃/费用、PG/RLS、历史恢复和部署门；这些不由本报告代替。
