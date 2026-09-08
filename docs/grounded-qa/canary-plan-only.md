# 限定合成 canary：仅规划

2026-09-09。入口 `bun run --cwd apps/web ./scripts/plan-grounded-canary.ts` 默认只规划；没有execute、数据库或模型调用能力。接受1–3个冻结题集中的文档ID，拒绝重复、未知路径及超限选择。`--review-template` 输出全部60题的人工待审阅草稿；实际Run、回答、命中、深读、评审人和支持关系计数均为null，不能直接提交为已通过评测报告。

默认选择 `synthetic-topic-1`、`timeline-old`、`timeline-new`，保持文档完整，不因费用或命中结果裁剪正文。题集SHA仍为 `55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e`；当前切片版本生成的plan SHA为 `b66be715f9b3676d722171d0b6dfc1a6d22e1e4f6d9f333bc5f4f7529c55feeb`。

## 实测规划结果

| 输入 | 原文UTF-8字节 | 片段数 | 每批4段的文档嵌入请求数 |
| --- | ---: | ---: | ---: |
| synthetic-topic-1 | 89205 | 1005 | 252 |
| timeline-old | 88 | 2 | 1 |
| timeline-new | 88 | 2 | 1 |
| 合计 | 89381 | 1009 | 254 |

这里只覆盖8题，不是完整60题验收。请求数按每文档分别分批计算，不含查询向量、重排和回答；UTF-8字节不是精确token，费用和token仍为null。`authorizedToExecute=false`，即使有plan SHA也不授予模型执行权限。

## 发现的问题与下一步

普通短段落被逐段切片，长文1005片段最大仅126字节，明显小于目标约768字符；直接跑此canary会增加不必要的请求和索引开销。这是实际切片输出，不是费用猜测；当前未进行任何嵌入调用。

下一步先修正普通段落打包逻辑，保留标题/聊天/代码/表格边界、原始offset与hash，版本化预处理并保护旧manifest/引用行为；重新运行本规划器、60题quote定位和原生PG回归，核验改善后再冻结新的canary计划。不得修改冻结题集以掩盖问题，不用期望quote代替实际检索结果，不在人工确认前宣称Recall/precision达标。
