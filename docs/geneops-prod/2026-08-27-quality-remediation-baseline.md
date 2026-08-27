# GeneOps 数据质量治理基线（2026-08-27）

本文件冻结 Petrichor 开始 GeneOps 数据质量治理前的代码、部署与只读数据库事实。它不包含凭据、连接串或业务正文。

## 回滚锚点

- Petrichor Git：`456c34873ded0a6ff42d15a655d1d0bd68ac4bff`
- Petrichor tag：`baseline/pre-geneops-quality-remediation-20260827`
- Petrichor production：`dpl_CQqKbc2rL3LzjJhMp3PurfAabiHu`，状态 `READY`
- GeneOps Git：`39f6616217755b6e12cd13f92f88595819977dbe`
- GeneOps tag：`baseline/pre-geneops-quality-remediation-20260827`
- Supabase：`geneops-prod` / `snsvqlqwnpyzcftubeab`
- 区域与版本：Singapore `ap-southeast-1`，PostgreSQL `17.6.1.141`
- 最新数据库迁移：`20260826171504_petrichor_connector_v1`

两个 annotated tag 均已推送到各自 GitHub `origin`，远端 peeled SHA 与上述 commit 一致。

## Supabase 只读快照

采集时间：`2026-08-27T07:30:44.818526+00:00`。

| 指标 | 数值 |
| --- | ---: |
| public 业务表 | 94 |
| public relation 总空间 | 5,021 MB |
| 数据库总空间 | 7,637 MB |
| source_documents | 56,816 |
| source_replies | 1,659,914 |
| completed search jobs | 56,816 |
| geneops_search_chunks | 180,632 |
| legacy wiki pages | 7,001 |
| Wiki V4 current artifacts | 314 |
| Wiki V4 topics | 2 |
| Wiki V4 relations | 0 |
| graph nodes | 82,805 |
| graph edges | 153,258 |

抓取计划 `latest`、`rolling`、`reconcile` 均为 disabled。来源账号只记录非敏感状态：

- WeAreSellers：两条 active 记录；一条最近状态为 valid，另一条缺少验证状态。
- WeChat MP：active，但状态为 `needs_interactive`。

## 已知质量门

- Exact/fuzzy 继续以原始帖子与回复为事实源。
- Semantic/hybrid 在回复映射审计完成前不得宣称全量回复覆盖。
- Wiki V4 在 artifact、topic、claim、relation 和 overview 门禁通过前保持 `wiki_ready=false`。
- 旧图谱仅作 exploratory；Graph v2 发布前保持 `graph_ready=false`。
- 私密悬赏帖只允许保留公开元数据，禁止绕过权限抓取正文或回复。
- 免费帖和常规悬赏帖必须通过真实登录态分页验收，确保可见回复不缺失。

## 当前实施分支

- Petrichor：`codex/geneops-quality-remediation`
- GeneOps：`codex/geneops-quality-remediation`

生产补抓、账号登录、模型批量调用和数据库写入均不属于本基线采集；它们各自保留独立审批与回滚门。
