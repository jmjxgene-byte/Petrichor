# @petrichor/web

React + Vite + TypeScript 全栈应用，包管理、本地服务与生产服务端运行时统一使用 **Bun 1.3.14**，目标部署环境为 **Vercel**，数据层使用 **Supabase PostgreSQL**。

> 📖 完整的简介、安全部署、环境变量速查表请看仓库根目录的 [`README.md`](../../README.md)。

## 本地开发

```bash
bun install
bun dev
```

只运行当前应用：

```bash
bun --filter "@petrichor/web" dev
```

## 环境变量

复制 `.env.example` 并填入数据库、Session、加密密钥和对象存储配置：

```bash
cp apps/web/.env.example apps/web/.env.local
```

每一项的作用见根 README 的[环境变量速查表](../../README.md#-环境变量速查表)。

## 初始化数据库

```bash
bun db:provision   # 全新空 Supabase，仅执行一次
bun db:bootstrap   # 创建结构并登记当前迁移，仅执行一次
bun db:migrate     # 后续发布前执行
```

管理员 URL和迁移 URL只存在于受控本地环境，禁止配置到 Vercel。完整步骤见
[`docs/database-migrations.md`](../../docs/database-migrations.md)。

认证使用 Better Auth + Drizzle，浏览器端通过 httpOnly Cookie 保持登录状态，不再依赖 `localStorage` token。

## 质量检查

```bash
bun test
bun typecheck
bun lint
bun build
```
