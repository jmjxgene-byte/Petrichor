# 限定合成 canary：仅规划

2026-09-09。入口 `bun run --cwd apps/web ./scripts/plan-grounded-canary.ts` 默认只规划；没有execute、数据库或模型调用能力。接受1–3个冻结题集中的文档ID，拒绝重复、未知路径及超限选择。`--review-template` 输出全部60题的人工待审阅草稿；实际Run、回答、命中、深读、评审人和支持关系计数均为null，不能直接提交为已通过评测报告。

默认选择 `synthetic-topic-1`、`timeline-old`、`timeline-new`，保持文档完整，不因费用或命中结果裁剪正文。题集SHA仍为 `55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e`。当前v2 plan SHA为 `61faa403c88032f3633e7b9a354101e8bdfe85a312c04dc8bca6d2f1a3f1f89d`，显式绑定preprocessingVersion=2；下表旧v1计划 `b66be715f9b3676d722171d0b6dfc1a6d22e1e4f6d9f333bc5f4f7529c55feeb` 仅保留作修复前对照，不可当作新批次授权。

## v1历史结果

| 输入 | 原文UTF-8字节 | 片段数 | 每批4段的文档嵌入请求数 |
| --- | ---: | ---: | ---: |
| synthetic-topic-1 | 89205 | 1005 | 252 |
| timeline-old | 88 | 2 | 1 |
| timeline-new | 88 | 2 | 1 |
| 合计 | 89381 | 1009 | 254 |

这里只覆盖8题，不是完整60题验收。请求数按每文档分别分批计算，不含查询向量、重排和回答；UTF-8字节不是精确token，费用和token仍为null。`authorizedToExecute=false`，即使有plan SHA也不授予模型执行权限。

## v2修复与当前结果

普通短段落此前逐段切片，长文1005片段最大仅126字节。v2只在同章节、同消息类型且非原子单元之间合并到最多768字符，代码/表格原子边界不变，原始offset/hash直接来自原字符串。新建manifest默认v2，读取接受并核验v1/v2各自原hash；执行及完成登记按任务manifest版本切片，旧任务不被新算法重解释。无数据库迁移，不自动重建或切换任何generation。

| 输入 | v2片段数 | 每批4段的文档嵌入请求数 |
| --- | ---: | ---: |
| synthetic-topic-1 | 46 | 12 |
| timeline-old | 1 | 1 |
| timeline-new | 1 | 1 |
| 合计 | 48 | 14 |

原文字节仍89381，片段文本字节总和同为89381；相对v1片段数减少约95.2%，请求数减少约94.5%（不代表质量改善比例）。测试冻结v1长文1005片段的旧集合hash，并验证v2原文完整、CRLF/emoji/标题/原子块及60题quote定位。原生PG验证v1当前→retired、v2成为current后旧会话和引用仍读v1，新会话读v2。全量1516通过/40既有跳过，原生PG75项通过，类型/Lint/build通过，隔离资源清理成功。

下一步按v2新计划独立批准限定模型批处理，再做实际检索和人工评审；未执行本次14次文档嵌入。不得修改冻结题集以掩盖问题，不用期望quote代替实际检索结果，不在人工确认前宣称Recall/precision达标。
