# 数据库初始化与迁移

Petrichor 把数据库结构变更与 Vercel 构建完全分开。发布顺序固定为：

**备份 → 迁移 → 验证 → 部署**

`MIGRATION_DATABASE_URL` 只存在于受控本地/CI 环境，不得配置到 Vercel。Vercel 运行时只持有权限受限的 `DATABASE_URL`。

## 全新 Supabase 项目

项目必须使用空的 `public` schema。先生成两个不同的强密码，并配置：

```bash
SUPABASE_ADMIN_DATABASE_URL=postgres://postgres:...@...:5432/postgres
PETRICHOR_MIGRATOR_PASSWORD=至少32位随机密码
PETRICHOR_RUNTIME_PASSWORD=另一个至少32位随机密码
```

执行一次：

```bash
bun db:provision
```

该命令会：

- 启用 `pg_trgm` 与 `vector`；
- 创建 `petrichor_migrator` 与 `petrichor_runtime`；
- 限制角色权限、连接 search path 与查询超时；
- 拒绝在已有 public 表或已有同名角色的项目中运行。

完成后移除管理员连接和两个明文角色密码。根据 Supabase Connect 页面生成：

- `MIGRATION_DATABASE_URL`：`petrichor_migrator` + Session Pooler 5432；
- `DATABASE_URL`：`petrichor_runtime` + Transaction Pooler 6543。

密码中的特殊字符必须进行 URL percent-encode。

## 首次 bootstrap

```bash
MIGRATION_DATABASE_URL=... bun db:bootstrap
```

bootstrap 在同一个数据库事务中：

1. 校验当前角色、schema 和必需扩展；
2. 拒绝任何已有 Petrichor 表的数据库；
3. 创建完整基础结构；
4. 执行 `docs/migrations/manifest.json` 中尚未登记的迁移；
5. 创建 `petrichor_schema_migration` ledger；
6. 为应用表启用 RLS，仅向 `petrichor_runtime` 授权；
7. 撤销 `PUBLIC`、`anon`、`authenticated`、`service_role` 权限。

再次运行 bootstrap 会被明确拒绝，避免误把初始化当作普通迁移。

## 后续迁移

```bash
MIGRATION_DATABASE_URL=... bun db:migrate
```

- `manifest.json` 是唯一执行清单，必须按文件名升序；
- `petrichor_schema_migration` 保存文件名、SHA-256 和耗时；
- 已执行迁移的 checksum 发生变化时会阻止发布；
- 所有待执行迁移与 RLS 加固位于同一个事务；
- `CREATE INDEX CONCURRENTLY` 等不能在事务内运行的操作必须单独走人工运维步骤。

新增迁移时创建新的 `.sql` 文件并登记到 manifest，禁止修改已执行文件。

## Vercel

`bun vercel-build` 只执行应用构建，不连接数据库，也不执行迁移。Production 环境不要配置：

- `MIGRATION_DATABASE_URL`
- `SUPABASE_ADMIN_DATABASE_URL`
- `PETRICHOR_MIGRATOR_PASSWORD`
- `PETRICHOR_RUNTIME_PASSWORD`

这些值只用于初始化或本地迁移，完成后应从当前 shell 和临时文件中清除。
