# 本机 PostgreSQL 验证

## 环境与隔离

用户已授权两种本机测试镜像，实际执行均按digest固定、原生arm64：

- PG：`pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`
- Bun：`oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`

入口：`bun run --cwd apps/web ./scripts/verify-grounded-postgres-local.ts`。仅允许本机Mac/OrbStack。数据库与非root客户端位于同一个`--internal`网络，无发布端口，各限1 CPU/512MiB、只读根文件系统与受控tmpfs。只读挂载迁移脚本、schema工具、迁移目录、验证客户端及postgres依赖；不挂载.env、SSH、业务文档、生产备份或完整工作区。采用无密码trust仅为隔离合成库建立角色身份，不验证生产密码认证。

## 实际结果

2026-09-08：客户端stage=done、passed=true，以下15项通过；宿主机报告passed=true、cleanupOk=true。执行后另行查询容器/网络/卷，确认无本次临时残留，镜像保留作测试缓存。

1. 客户端目标仅允许指定格式的临时容器。
2. 服务端cluster_name匹配随机测试身份且版本为PG17。
3. 使用真实项目migrate-database.ts执行bootstrap成功。
4. 第二次bootstrap因已有业务表被拒绝。
5. 再次migrate为0条待执行。
6. 所有匹配Petrichor/Better Auth业务表均启用RLS。
7. anon无直接表SELECT权限。
8. authenticated无直接表SELECT权限。
9. service_role无直接表SELECT权限（测试角色具备BYPASSRLS）。
10. runtime建表被SQLSTATE 42501拒绝。
11. runtime读取迁移账本被42501拒绝。
12. 未完成generation不能成为current（23514）。
13. 合成1024维向量的维度与自身余弦距离正确。
14. 生成tsvector列可实际查询。
15. 删除合成文档时派生passage级联清理。

同时typecheck/lint/build/diff通过，全量1479测试通过、40既有跳过。没有真实模型、Worker或生产操作。

## Deep 应用状态机追加验证

2026-09-08：同一隔离入口增加只读 allowlist 挂载：实际 job-store、db client/schema、配置解析与其必要纯模块、tsconfig、Drizzle/Zod 依赖和合成 fixture。没有挂载整个源码树或环境文件。fixture 在检查本机容器地址后注入合成配置，调用真实应用函数，不启动 Worker 或模型；使用 runtime 角色和三个应用池连接。

最新终验共 **38 项客户端检查通过**（原15项及23项 Deep 检查），宿主 passed/cleanupOk 均为 true；独立 Docker 检查确认容器、网络及卷无残留。Deep 覆盖并发幂等创建、用户 ID 过滤、两个 worker 并发领取唯一任务、heartbeat 所有者、执行占位唯一、并发完成后只有一条结果消息且重复调用可恢复、Agent Run 同事务完成、排队/运行取消、取消所有者、未占位租约可恢复且 attempt 增加、已占位租约失败不重放、真实行锁下 SKIP LOCKED 跳过及释放后可领取、缺失 Run 时完成事务回滚（消息数不增加、Job 保持 running）。并发完成竞争允许失败方回滚，不等于所有竞争调用均成功。

首次追加测试在 deep_recovery_claim 停止，资源清理成功；测试原先在创建后立即领取，PG 默认时间含微秒而 JS Date 为毫秒。改为显式设置合成任务 available_at 为过去，消除测试对即时到期边界的依赖，随后19项及补强后的23项均通过；未据此修改生产调度逻辑。回归1479通过/40既有跳过，typecheck/lint通过。

这不是 HTTP/Worker 端到端或任意故障组合证明：没有真正杀死 Worker，也未执行真实模型、跨进程重启、全部 API 归属路径或旧库升级。应用角色 RLS 不是每用户 RLS；用户过滤仅验证了 job-store 查询的一条路径。

## 失败路线与范围

### 实际索引搜索、阅读和任务函数（2026-09-08）

用户选择完整MVP验收后再部署，不发布单独热修。新增 `verify-index-postgres-fixture.ts`，沿用同一隔离库及必要源码白名单；嵌入provider改为Hybrid分支内惰性导入，关键词路径不加载模型SDK。测试未挂载provider或配置模型，仍保持Hybrid=false，不模拟语义质量。

最新完整终验 **75项通过**：原51项加24项索引检查。使用真实passage builder与manifest builder建立500段合成前文及末尾校验码，在原生tsvector上调用实际searchDocumentIndex/readDocumentIndexPassage，确认末尾命中、≤4000字符窗口保留完整anchor、引用身份、外用户无法搜索/读取、错hash拒绝、原Run固定retired代际/新Run读取current、旧引用可读、原文更新后旧引用拒绝与新会话明确降级、取消与过期预算停止、删除后不可阅读。实际index-jobs函数另验证并发单槽、heartbeat归属/成功、预算越界、预占一次、过期heartbeat拒绝、已预占租约不重放及generation失败终态。合成预算仅验证嵌入队列约束，不恢复CPA聊天/Deep的美元限制。

typecheck/lint/build/diff通过，回归1483通过/40既有跳过，宿主cleanupOk=true。这是实际函数+原生PG合成验收，不是HTTP完整身份链、真实文件索引构建、真实embedding/rerank、Worker进程崩溃、人工引用支持度或性能P95验收。真实模型小样本与Staging仍是下一阶段。

### 固定旧基线升级与故障回滚（2026-09-08）

当前入口改为先从固定 Git 对象 `b6eac4c729658c04655edc535367f4c7c51c6189` 导出迁移白名单，使用该版本真实 bootstrap 创建8条迁移的旧结构；确认没有新 generation 表，写入合成旧用户。临时导出仅包含迁移代码和清单，数据库只在 tmpfs 中存在，不使用生产备份。

失败路径使用容器 tmpfs 中的迁移副本：先执行当前新增索引迁移，再执行合成建表和旧用户字段更新，最后执行 `select 1/0`。确认错误为22012、前一合成迁移已执行完成，随后验证新增索引表和marker均不存在、旧用户字段不变、包含 checksum/时间/执行耗时的迁移ledger完全不变。正常路径重新用原始当前脚本升级，精确执行1条迁移；旧用户不变、重复bootstrap拒绝、重复migrate为0。之后继续权限、vector和实际Deep验证。

最后一轮 **48项通过**，包含12组三并发幂等创建；宿主 passed/cleanupOk=true，另外核验临时容器/网络/卷均为空，固定基线导出目录和故障副本已清理。

首轮升级/回滚通过后，Deep首个并发创建发生一次错误，当时报告仅截断了Drizzle SQL包装错误，无法确认SQLSTATE。随后补充安全SQLSTATE/字段/约束分类，普通复验47项、12组三并发补强48项通过但未重现。这个历史失败不再作为未定位问题，见下节已复现修复；测试仍不覆盖线上漂移、全部业务表内容或完整Supabase托管行为。

### Deep 双唯一索引竞争修复

2026-09-08将同一合成测试加至最多200组三并发，旧实现实际失败：SQLSTATE `23505`，约束 `ux_petrichor_deep_research_job_run_key`。服务端根据幂等键确定run_key，因此重复请求同时触及两个唯一索引；原先只指定idempotency_key为冲突目标，不能覆盖另一个索引的并发冲突。按 [PostgreSQL 17 INSERT文档](https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT) 改为不指定目标的DO NOTHING，再按完整幂等键、用户、thread、question、scope hash和fast run过滤原任务。真正的run_key碰撞或归属不匹配仍报安全冲突；不加自动重试、不删除唯一约束、不复制任务。

修复后同一隔离测试 **51项通过**，其中200组三并发全部收敛为同一ID，并通过不同幂等键run碰撞、scope碰撞和fast-run碰撞拒绝检查；升级/回滚、claim/reservation/complete/cancel均再次通过，宿主cleanupOk=true。新增4个单元用例覆盖无冲突目标、返回已有记录、真实碰撞拒绝、其他数据库错误不吞掉或重试。此修复自身不新增迁移；MVP整体仍另有待发布索引迁移和真实检索验收，不能混同为整个MVP已通过发布门。

此前宿主机连接方案在内部网络下无发布端口，两次均在迁移前失败并清理；第二次确认PG已正常启动、无OOM，Ports中的5432/tcp为null。没有改用开放网络；获新增Bun镜像授权后使用同网客户端解决。

此结果不等于Supabase托管服务验收：RLS策略允许服务端runtime角色访问，用户级隔离仍需应用接口验证；未测试security-definer等全部间接访问路径。固定旧基线升级和注入失败事务回滚已测试，但不是生产备份演练。索引API/查询性能、真实语义质量及Staging仍待后续验证。合成向量不代表已执行embedding。
