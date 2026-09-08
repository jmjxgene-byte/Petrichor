# 可信问答离线评测报告

运行 `bun run qa:eval /path/to/restricted-report.json`；这是本地报告校验，不会访问数据库、来源或模型。退出码0表示这份报告的检索指标门通过，1表示未通过，2表示输入无效；任何结果都不等于整个MVP可以发布。

输入结构以 `apps/web/src/server/retrieval/grounded-evaluation.ts` 的严格schema为准。只接收元数据：冻结datasetSha、相同题集的baselineDatasetSha、60条逐题记录，不接收query、answer、正文或原始RPC。私有题目和人工标注材料留在受限环境，报告保留证据身份用于本地对账；stdout仅输出聚合分数与安全原因码。

题目分组固定为terms 15、late_passage 15、synthesis 10、followup 10、no_answer 5、temporal 5。每题绑定人工相关证据expectedEvidenceIds、期望的answer/clarify/insufficient和真实运行结果；semantic标签在测试前冻结，不能看结果后挑子集。retrievedIds保持原始排名，readIds只记录实际深读过的证据，baselineRetrievedIds来自旧版本同题集的实际运行；不允许用搜索结果冒充深读。

reviewer必须由人工审查材料核实为human；claims/ reviewedClaims/ supportedClaims分别是事实性结论—引用关系总数、已审核数、被资料支持数。合法引用编号不是支持判断，模型自评不能替代人工。评测器无法认证审查者身份或判断输入是否伪造，验收负责人仍须查阅原始运行证据、冻结题集和人工复核材料；单独填入human并不构成证明。

Recall@20按有答案题逐题计算后宏平均，重复命中只算一次且不回补第21名；语义子集须优于基线，术语题逐题不退化。人工支持precision使用全部结论关系作分母，缺审核则不提供通过分数。文末题必须有gold证据进入readIds。每题标明是否预期经过本地检索localExpected，localMs只统计该子集，缺测不能以0代替；P95采用nearest-rank。fastMs不得超过8000。记录retrievalRecorded、unsafeResults、unknownTimeAssertions，分别对应实际执行留痕、越权/限制内容泄漏和未知时间确定性断言。

当前只有合成记录单元测试，尚无冻结的真实60题、旧/新检索运行或人工支持标注。另需验收Deep 180秒、队列/取消/崩溃/费用、PG/RLS、历史恢复和部署门；这些不由本报告代替。
