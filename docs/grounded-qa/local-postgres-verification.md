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

## 失败路线与范围

此前宿主机连接方案在内部网络下无发布端口，两次均在迁移前失败并清理；第二次确认PG已正常启动、无OOM，Ports中的5432/tcp为null。没有改用开放网络；获新增Bun镜像授权后使用同网客户端解决。

此结果不等于Supabase托管服务验收：RLS策略允许服务端runtime角色访问，用户级隔离仍需应用接口验证；未测试security-definer等全部间接访问路径。当前bootstrap从最新初始化SQL运行，尚未模拟旧生产版本升级或失败迁移的完整回滚。Deep状态机并发/租约、索引API/查询性能、真实语义质量及Staging仍待后续验证。合成向量不代表已执行embedding。
