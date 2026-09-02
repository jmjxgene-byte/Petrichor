<div align="center">

<img src="apps/web/public/sidebar-logo.jpg" alt="Petrichor" width="120" height="120" />

# Petrichor

**一个开箱即用的全栈知识库与博客平台 · 基于 Bun + React + Vite + Supabase + Vercel**

*An open-source full-stack knowledge base & blog platform built with Bun, React, Vite, Supabase and Vercel.*

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-1.3-black?logo=bun)](https://bun.sh)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)](#-安全部署流程)

[**🌐 产品介绍**](https://wl.do/tags) ·
[**📖 在线 Demo（前台）**](https://wl.do)

[**🚀 安全部署到 Vercel**](#-安全部署流程) ·
[功能特性](#-功能特性) ·
[环境变量](#-环境变量速查表) ·
[本地开发](#-本地开发) ·
[English](#english)

</div>

---

<div align="center">

### 💬 微信交流群

<img src="apps/web/public/wechat-group-qr.png" alt="微信交流群二维码" width="220" />

扫码添加作者微信（Cizai_），交流使用与开发问题，并拉你进交流群

</div>

---

## 📖 简介

**Petrichor**是一个个人/小团队场景下的现代化知识库与博客平台，集成了富文本编辑器、知识库管理、文章发布、AI 写作助手、对象存储上传等能力。

整套系统支持 **Vercel + Supabase** 部署，零自建服务器即可上线，仅需配置好环境变量就能拥有一个完整可用的内容平台。

---

## ✨ 功能特性

| 模块 | 能力 |
| --- | --- |
| **📝 富文本编辑器** | 基于 PlateJS，支持 Markdown、代码块、表格、数学公式、白板、思维导图、媒体嵌入等 |
| **📚 知识库** | 多层级目录树、文章标签、文章分享、文章 RSS/Atom Feed |
| **🤖 AI 助手** | AI 续写 / 改写 / 翻译 / 语气调整、AI 文章总结 |
| **🔐 认证体系** | Better Auth + httpOnly Cookie，支持邮箱密码、LinuxDo OAuth、二步验证 |
| **🗂️ 对象存储** | S3 兼容上传（封面、附件、头像），支持预签名 URL |
| **📊 仪表盘** | 写作数据统计、活跃度图、知识库分布 |
| **🎨 主题与外观** | 浅色/深色模式、自定义网站标题/图标、Retypeset 主题博客首页 |
| **🌐 公开站点** | 文章公开页、SEO 元数据、RSS、Atom、sitemap.xml |
| **🛠️ Agent 集成** | API Key 管理、MCP Server（Streamable HTTP，兼容 Claude Code / Codex / Cursor）、Skill 包（兼容 Claude Code / Codex）、调用审计日志、REST 能力层 |

---

## 🚀 安全部署流程

> 生产部署不再执行“一键建库”。数据库权限、初始化与应用构建分离，避免 Vercel 构建拿到迁移凭据或公开注册被绕过。

### 第 1 步：创建全新 Supabase 项目

1. 新建独立项目，建议选择与 Vercel Function 相同或相邻的区域。
2. 保持 `public` schema 为空，不要手工粘贴初始化 SQL。
3. 准备管理员连接、迁移角色密码、运行角色密码；两个角色密码必须不同且至少 32 位。
4. 在本地配置 `SUPABASE_ADMIN_DATABASE_URL`、`PETRICHOR_MIGRATOR_PASSWORD`、`PETRICHOR_RUNTIME_PASSWORD`，执行：

```bash
bun install --frozen-lockfile
bun db:provision
```

命令会启用 `pg_trgm` / `vector`，并创建最小权限的 `petrichor_migrator` 与 `petrichor_runtime`。详细约束见 [数据库初始化与迁移](docs/database-migrations.md)。

### 第 2 步：初始化数据库

从 Supabase Connect 页面生成：

- `MIGRATION_DATABASE_URL`：迁移角色 + Session Pooler 5432；
- `DATABASE_URL`：运行角色 + Transaction Pooler 6543。

先执行一次 bootstrap，再确认后续迁移为空：

```bash
MIGRATION_DATABASE_URL=... bun db:bootstrap
MIGRATION_DATABASE_URL=... bun db:migrate
```

bootstrap 会创建完整结构、登记增量迁移、启用 RLS，并撤销 `PUBLIC` / `anon` / `authenticated` / `service_role` 权限。第二次执行 bootstrap 会被拒绝。

### 第 3 步：准备私有 S3 Bucket

Bucket 保持私有，通过服务端生成的预签名 URL 上传和下载。CORS 只允许正式站点域名，并准备：

- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

### 第 4 步：生成稳定密钥

```bash
openssl rand -base64 32 # SESSION_SECRET
openssl rand -base64 32 # PETRICHOR_ENCRYPT_KEY
openssl rand -hex 8     # PETRICHOR_ENCRYPT_SALT
```

这些值一旦用于真实数据不可随意更换。

### 第 5 步：创建 Vercel 项目

以仓库根目录创建 Bun 项目。Production 只配置运行时 Sensitive Variables：

- `DATABASE_URL`
- `SESSION_SECRET`
- `PETRICHOR_ENCRYPT_KEY`
- `PETRICHOR_ENCRYPT_SALT`
- `APP_BASE_URL`
- `S3_*`
- `PETRICHOR_REGISTRATION_MODE=disabled`
- `PETRICHOR_PUBLIC_REGISTER_ENABLED=false`
- `PETRICHOR_PUBLIC_LINUXDO_ENABLED=false`

不要向 Vercel 配置管理员 URL、迁移 URL或数据库角色明文密码。Vercel 构建只执行应用构建，不会修改数据库。

### 第 6 步：创建首位超级管理员

公开注册不会自动产生管理员。使用受控命令创建一次：

```bash
PETRICHOR_ADMIN_EMAIL=admin@example.com \
PETRICHOR_ADMIN_NAME=Admin \
PETRICHOR_ADMIN_PASSWORD='至少12位强密码' \
DATABASE_URL='运行角色连接串' \
SESSION_SECRET='稳定会话密钥' \
PETRICHOR_ENCRYPT_KEY='稳定加密密钥' \
PETRICHOR_ENCRYPT_SALT='16位hex' \
bun user:create-admin
```

若系统中已存在超级管理员，命令会拒绝重复引导。生产环境保持 `PETRICHOR_REGISTRATION_MODE=disabled`。

### 第 7 步：验证与发布

本地依次运行：

```bash
bun test
bun typecheck
bun lint
bun build
bun audit --audit-level=high
```

部署后验证 `/healthz`、管理员登录、知识库 CRUD、AI 凭证加解密、S3 上传下载、公开文章与 RSS，再检查 Vercel Runtime Logs 和 Supabase Advisors。

---

## 🔐 环境变量速查表

### ✅ 必填（缺一不可，否则启动失败）

| 变量 | 类型 / 校验 | 用于什么功能 |
| --- | --- | --- |
| `DATABASE_URL` | Postgres 连接串，非空 | **所有数据持久化**：用户、文章、知识库、通知、AI 配置、上传记录等。生产环境务必使用 Supabase **Transaction Pooler** 连接串（端口 6543） |
| `SESSION_SECRET` | base64 字符串，**至少 32 字符** | **登录会话 Cookie 签名**（Better Auth）。一旦上线**不要修改**，否则所有已登录用户会被踢下线 |
| `PETRICHOR_ENCRYPT_KEY` | 稳定随机字符串，至少 32 字符 | **AI 模型 API Key 加密存储**。缺失时服务拒绝启动；一旦产生密文不可随意更换 |
| `PETRICHOR_ENCRYPT_SALT` | 16 位十六进制字符串 | 与 `PETRICHOR_ENCRYPT_KEY` 配套使用的盐值。**一旦有真实数据后不能再换**，否则历史密文无法解密 |

### 📦 对象存储（上传相关功能依赖；不配则上传按钮会报错）

| 变量 | 用于什么功能 |
| --- | --- |
| `S3_ENDPOINT` | S3 接入点（含或不含 `https://` 均可，未带协议时会自动按 `S3_USE_SSL` 补全） |
| `S3_REGION` | 区域，默认 `us-east-1` |
| `S3_BUCKET` | 存储桶名 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | S3 凭据，用于服务端签名预签名 URL |
| `S3_UPLOAD_EXPIRE_SECONDS` | 上传用预签名 URL 有效期（秒），默认 `900` |
| `S3_DOWNLOAD_EXPIRE_SECONDS` | 下载用预签名 URL 有效期（秒），默认 `3600` |
| `S3_USE_SSL` | `S3_ENDPOINT` 未带协议时是否补 `https://`，默认 `true` |

**用到 S3 的功能：** 文章封面上传、附件上传、用户头像上传、知识库文件附件、AI 文章总结配图等。

### 🌐 应用与公开页

| 变量 | 用于什么功能 |
| --- | --- |
| `APP_BASE_URL` | **公开站点完整 URL**（如 `https://yourdomain.com`、`https://你的项目.vercel.app`）。用于：文章分享链接、RSS/Atom 链接生成、OAuth 回调地址 fallback、SEO `og:url`。部署完成后**务必回填**为真实域名 |
| `PETRICHOR_REGISTRATION_MODE` | 服务端权威注册模式，只允许 `disabled` / `open`，默认 `disabled`；Production 保持关闭 |
| `PETRICHOR_PUBLIC_REGISTER_ENABLED` | 仅控制登录页是否显示注册入口；不能代替服务端注册模式校验 |
| `PETRICHOR_PUBLIC_LINUXDO_ENABLED` | 构建时控制 LinuxDo 登录/绑定入口；未配置完整 OAuth 凭据时保持 `false` |
| `PETRICHOR_SESSION_EXPIRE_SECONDS` | 登录态有效期（秒），默认 `172800`（2 天） |

### 🔗 LinuxDo OAuth（可选第三方登录）

不需要 LinuxDo 登录可以**全部留空**。

| 变量 | 用于什么功能 |
| --- | --- |
| `PETRICHOR_LINUXDO_CLIENT_ID` | LinuxDo OAuth 应用 Client ID |
| `PETRICHOR_LINUXDO_CLIENT_SECRET` | LinuxDo OAuth 应用 Client Secret |
| `PETRICHOR_LINUXDO_REDIRECT_URI` | OAuth 回调地址，需与 LinuxDo 应用注册一致；留空则取 `APP_BASE_URL + /api/auth/callback` |

> 在 <https://connect.linux.do> 注册一个 OAuth 应用即可获得 ID 和 Secret，回调地址填 `https://你的域名/api/auth/callback`。

---

## 🛠️ Agent 集成（Skill 包 / REST 能力层）

Petrichor 内置了一套**面向外部 Agent**（Claude Code、Codex、Cursor、ChatGPT 桌面端等）的开放能力，让 AI 工具能直接读写你的知识库。

### 能力一览

| 子模块 | 入口 | 说明 |
| --- | --- | --- |
| **API Key 管理** | 仪表盘 → Agent 集成 → API Key 管理 | 生成 / 撤销外部 Agent 调用密钥。明文仅展示一次，服务端只存 `sha256` 哈希 |
| **Skill 包** | 仪表盘 → Agent 集成 → Skill 包 | 下载 `petrichor-agent-skills.zip`，内含一个顶层 `petrichor` Skill 与 `config.json`；兼容旧单文件 `SKILL.md` |
| **调用日志** | 仪表盘 → Agent 集成 → 调用日志 | 完整审计：来源 Agent、工具、IP、UA、入参、出参、状态码、耗时 |
| **REST 能力层** | `/api/agent/**` | 所有外部接口统一鉴权 + 审计，可直接被任意 HTTP 客户端调用 |

### Skill 包结构

下载后的压缩包是一个顶层 `petrichor/` Skill，外部 Agent 工具的侧栏只会出现一个 `petrichor`。根目录 `SKILL.md` 内置路由表，按用户意图按需读取下列子文档（不会一次性加载）：

| 子文档 | 触发时机 |
| --- | --- |
| `config.json` | Skill 包内配置文件，填写站点地址与 Agent API Key |
| `skills/setup.md` | 首次配置、自检、API Key 权限检查、接口发现 |
| `skills/articles.md` | 新建 / 更新 / 删除文章、创建文件夹、移动文章 |
| `skills/docs.md` | 浏览知识库、查看目录树、列文章、搜索文档、查看正文 / Wiki |
| `skills/qa.md` | 基于知识库上下文的文档问答（含跨库问答） |
| `skills/share.md` | 公开 / 撤销文章分享、设置访问密码与到期时间 |
| `skills/ai.md` | AI 摘要、思维导图、知识图谱生成 |

`scripts/petrichor`（零依赖 Python CLI）、`scripts/petrichor-api.sh`（curl 兜底）和 `references/endpoints.md`（完整接口字段说明）整个 skill 共用一份，默认读取同目录的 `config.json`。

### 接入步骤

1. **生成 API Key**：仪表盘 → **Agent 集成 → API Key 管理 → 新建**，按需勾选权限（`article:write` / `article:delete` / `doc:read` / `qa:read`），保存明文。
2. **下载 Skill 包**：仪表盘 → **Agent 集成 → Skill 包 → 下载包**，或直接访问 `/api/agent/skill-pack`，得到 `petrichor-agent-skills.zip`。
3. **导入 Agent 工具**：解压后将 Skill 目录放入 Claude Code / Codex 对应的 Skills 路径（参考各工具文档）。
4. **编辑配置文件**：打开解压后的 `petrichor/config.json`，确认 `baseUrl`，并把 `apiKey` 改成上一步生成的明文 Key。
5. **调用约定**：Skill 包内 CLI 会从 `config.json` 读取 `apiKey`，并自动携带 `Authorization: Bearer <apiKey>`。
6. **审计**：每次调用都会自动写入「调用日志」，登录用户可在仪表盘内回看。

> 公开接口清单：未带鉴权也能访问的 `GET /api/agent/manifest` 会列出全部可用接口、参数和所需权限，方便 Agent 自动发现能力。详细设计见 [`docs/agent-integration.md`](docs/agent-integration.md)。

### 🧪 完整模板

参考 [`apps/web/.env.example`](apps/web/.env.example) 或直接复制：

```ini
# 必填
DATABASE_URL="postgres://petrichor_runtime.[project-ref]:[password]@[pooler-host]:6543/postgres"
SESSION_SECRET="<openssl rand -base64 32 的输出>"
PETRICHOR_ENCRYPT_KEY="<openssl rand -base64 32 的输出>"
PETRICHOR_ENCRYPT_SALT="<openssl rand -hex 8 的输出>"

# S3 兼容对象存储
S3_ENDPOINT="https://s3.example.com"
S3_REGION="us-east-1"
S3_BUCKET="your-bucket"
S3_ACCESS_KEY_ID="your-access-key-id"
S3_SECRET_ACCESS_KEY="your-secret-access-key"
S3_UPLOAD_EXPIRE_SECONDS="900"
S3_DOWNLOAD_EXPIRE_SECONDS="3600"
S3_USE_SSL="true"

# 应用 URL 与注册策略
APP_BASE_URL="https://yourdomain.com"
PETRICHOR_PUBLIC_REGISTER_ENABLED="false"
PETRICHOR_REGISTRATION_MODE="disabled"
PETRICHOR_SESSION_EXPIRE_SECONDS="172800"

# 可选：LinuxDo OAuth
PETRICHOR_LINUXDO_CLIENT_ID=""
PETRICHOR_LINUXDO_CLIENT_SECRET=""
PETRICHOR_LINUXDO_REDIRECT_URI=""
```

---

## 💻 本地开发

### 前置依赖

- Bun **1.3.14**（包管理、本地服务与生产服务端运行时）
- Node.js **≥ 22**（仅用于 Vitest、ESLint、TypeScript 等本地质量工具）
- 一个可用的 Postgres 数据库（Supabase / 本地 Docker / 远程均可）

### 启动

```bash
git clone https://github.com/Ciao1019/Petrichor.git petrichor
cd petrichor
bun install
cp apps/web/.env.example apps/web/.env.local
# 编辑 apps/web/.env.local 填入真实值

# 本地开发可把 DATABASE_URL 改为 file:/tmp/petrichor-dev.sqlite；
# 生产 Supabase 初始化见 docs/database-migrations.md。

bun dev
```

打开 <http://localhost:3000>。

### 常用命令

```bash
bun dev           # 启动开发服务器
bun build         # 生产构建
bun test          # 单元测试（Vitest）
bun typecheck     # TypeScript 类型检查
bun lint          # ESLint
```

---

## 📁 项目结构

```
.
├── apps/
│   └── web/                     # Bun + React + Vite 全栈应用
│       ├── app/                 # App Router 入口、API route、RSS/sitemap
│       │   └── api/agent/       # 外部 Agent REST 能力层（manifest / skill / skill-pack 等）
│       ├── src/
│       │   ├── client-app.tsx   # 客户端 SPA 入口
│       │   ├── features/pages/  # 业务页面（dashboard / blog / kb / ai / agent / admin ...）
│       │   ├── components/      # 通用组件 + shadcn/ui
│       │   ├── lib/             # 前端工具与 API client
│       │   ├── server/          # 服务端 handler / 业务逻辑 / Drizzle schema
│       │   │   └── agent/       # Agent 接入逻辑：API Key、Skill 生成、审计
│       │   └── config/          # 环境变量解析与服务端配置
│       └── .env.example
├── docs/
│   ├── petrichor-init.sql       # 完整初始化 SQL（与代码同步）
│   ├── create-first-admin.sql   # 创建第一个超级管理员账号的 SQL 模板
│   ├── agent-integration.md     # Agent 集成（Skill 包 / REST）设计说明
│   ├── migrations/              # 历史增量迁移脚本
│   └── assets/                  # 文档资源（logo 等）
├── AGENTS.md                    # 给 AI 协作者的项目级说明
├── LICENSE                      # Apache 2.0
└── README.md
```

---

## 🤝 贡献

欢迎 Issue / PR。提交前请确保：

```bash
bun typecheck
bun lint
bun test
```

全部通过。

代码风格、提交约定、UI 复用与目录规范详见 [`AGENTS.md`](AGENTS.md)。

---

## 🙏 致谢

- 本项目的前台公开站点 UI 与排版设计借鉴自 [**astro-theme-retypeset**](https://github.com/radishzzz/astro-theme-retypeset) —— 一个优雅、克制、专注阅读的 Astro 博客主题。感谢作者 [@radishzzz](https://github.com/radishzzz) 在中文排版与视觉细节上的精心打磨，为本项目的公开页提供了重要灵感。
- 感谢 [LinuxDo](https://linux.do/) 社区的支持。
---

## 📄 License

[Apache License 2.0](LICENSE) © 2026 Petrichor Contributors

---

## English

**Petrichor** (repo codename *Dosphere*) is a self-hostable knowledge-base & blog platform powered by **Bun 1.3 + React 19 + Vite 7 + Supabase + Vercel**, featuring a PlateJS rich-text editor, multi-level knowledge tree, AI writing assistant (continue / rewrite / translate / tone), S3-compatible uploads, Better Auth with optional LinuxDo OAuth, and an **Agent integration layer** (REST + downloadable Skill packs compatible with Claude Code / Codex) with full call auditing.

### Links

- 🌐 **Product site**: <https://petrichor.wl.do>
- 📖 **Live demo (public site)**: <https://wl.do>

### Secure deploy

1. Create a dedicated, empty Supabase project.
2. Configure `SUPABASE_ADMIN_DATABASE_URL` and two distinct 32+ character role passwords, then run `bun db:provision` once.
3. Build a Session Pooler URL for `petrichor_migrator` and run `bun db:bootstrap` once.
4. Build a Transaction Pooler URL for `petrichor_runtime`; this is the only database URL stored in Vercel.
5. Create a private S3-compatible bucket and stable session/encryption secrets.
6. Create the first super-admin with `bun user:create-admin`; public sign-up never auto-promotes an administrator.
7. Run tests, typecheck, lint, build and `bun audit --audit-level=high` before deploying.

Database migrations are never run during a Vercel build. See [database initialization and migrations](docs/database-migrations.md) for the exact role, RLS and release workflow.

### Required env

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (use Supabase Transaction Pooler in production) |
| `SESSION_SECRET` | Better Auth cookie signing key (≥ 32 chars) |
| `PETRICHOR_ENCRYPT_KEY` / `PETRICHOR_ENCRYPT_SALT` | AES-style encryption for stored AI provider API keys |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Object storage for uploads (article covers, attachments, avatars) |
| `APP_BASE_URL` | Public site URL — used by RSS, share links, OAuth callbacks, SEO metadata |

### Optional env

| Variable | Purpose |
| --- | --- |
| `PETRICHOR_REGISTRATION_MODE` | Authoritative server mode: `disabled` or `open`; keep production disabled |
| `PETRICHOR_PUBLIC_REGISTER_ENABLED` | UI-only visibility of the sign-up entry; it never replaces the server gate |
| `PETRICHOR_PUBLIC_LINUXDO_ENABLED` | Build-time visibility for LinuxDo login/binding; keep `false` until OAuth is fully configured |
| `PETRICHOR_SESSION_EXPIRE_SECONDS` | Session lifetime in seconds (default `172800`) |
| `PETRICHOR_LINUXDO_CLIENT_ID` / `PETRICHOR_LINUXDO_CLIENT_SECRET` / `PETRICHOR_LINUXDO_REDIRECT_URI` | LinuxDo OAuth (optional third-party login) |

See the full breakdown in the [Chinese section above](#-环境变量速查表).

### Agent integration

Petrichor exposes a permissioned REST layer at `/api/agent/**` for external AI agents (Claude Code, Codex, Cursor, ChatGPT Desktop, …), together with a downloadable **Skill pack** containing a single top-level `petrichor` Skill that routes by user intent into sub-docs for setup, articles, docs, qa, share and AI generation.

1. **Generate an API key** in *Dashboard → Agent 集成 → API Key 管理* (plaintext shown once; only `sha256` is persisted).
2. **Download the Skill pack** (`petrichor-agent-skills.zip`) from the dashboard or `/api/agent/skill-pack`, then import it into your agent tool.
3. **Edit `petrichor/config.json`**: confirm `baseUrl` and paste the generated API key into `apiKey`.
4. **Call convention**: the packaged CLI reads `config.json` and sends `Authorization: Bearer <key>`.
5. **Audit**: every call (source, tool, IP, UA, request, response, status, latency) is recorded in *Dashboard → Agent 集成 → 调用日志*.

Public manifest endpoint (no auth) for capability discovery: `GET /api/agent/manifest`. Full design notes in [`docs/agent-integration.md`](docs/agent-integration.md).

### Acknowledgements

- The public-facing site's UI and typography were inspired by [**astro-theme-retypeset**](https://github.com/radishzzz/astro-theme-retypeset) by [@radishzzz](https://github.com/radishzzz) — an elegant, reading-focused Astro blog theme with carefully crafted CJK typography.
- Thank you to the [LinuxDo](https://linux.do/) community for your support.
### License

[Apache License 2.0](LICENSE)
