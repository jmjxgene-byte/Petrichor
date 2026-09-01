# Petrichor 自托管运行手册

目标环境为 Gene-OVH + 1Panel/OpenResty，staging 使用 `petrichor-staging.genejm.one`，正式切换为 `petrichor.genejm.one`。Vercel Production 在切换后至少保留 48–72 小时作为回滚。

## 发布边界

- Web 只绑定宿主机 `127.0.0.1:3000`，公网仅通过 OpenResty/Cloudflare 访问。
- 构建与运行使用 `Dockerfile.selfhost`；Vercel 配置和 `Dockerfile.vercel` 保持不变。
- 容器不执行数据库迁移；迁移仍通过本地受控 `MIGRATION_DATABASE_URL` 在发布前完成。
- `.env.production` 只存在于服务器且权限为 0600，不进入镜像、Git、日志或 1Panel 公共变量页面。
- `SESSION_SECRET`、`PETRICHOR_ENCRYPT_KEY`、`PETRICHOR_ENCRYPT_SALT` 必须沿用当前 Production 值。

## 数据库连接

自托管 Web 使用 Petrichor Supabase Session Pooler 5432，`PETRICHOR_DB_MAX_CONNECTIONS=5`、`prepare:false`；未来 Worker 使用独立进程并设置连接池 1。GeneOps 外部只读连接首版继续使用 Transaction Pooler 6543、`max:1`、`prepare:false`。

## Staging 发布

1. 将 `deploy/selfhost/selfhost.env.example` 复制为服务器上的 `.env.production`，填入现有 Production Secret 并设置 0600。
2. 确认 `APP_BASE_URL`、LinuxDo 回调和 S3 CORS 包含 staging 域名。
3. 在 `deploy/selfhost` 执行 `PETRICHOR_ENV_FILE=./.env.production docker compose --env-file .env.production config`，确认没有未解析变量；仓库验收可将 `PETRICHOR_ENV_FILE` 指向 `selfhost.env.example`。
4. 使用干净 Git SHA 构建镜像：`docker compose --env-file .env.production build --pull=false web`。
5. 启动：`docker compose --env-file .env.production up -d web`，等待容器 healthy。
6. 将 `openresty-location.conf` 中的 location 合并进 1Panel 管理的 HTTPS 站点；TLS 证书和 Cloudflare Real IP 规则继续由 1Panel 管理。

## 验收

- `/healthz` 返回 200/Bun，HTML `no-cache`，`/assets/*` 保持 immutable。
- 登录、退出、2FA、Session Cookie 与管理员权限正常。
- S3 上传、下载、删除和 staging CORS 正常。
- AI 流式回答无代理缓冲，长请求不在 300 秒内被 OpenResty 终止。
- GeneOps Exact/Fuzzy 可用；v1/stale/unready 时 Wiki、Graph、Backlinks 服务端返回质量未就绪。
- MCP/REST、Cron、容器重启和数据库连接池并发验收通过。

## Cron

把 `deploy/selfhost/cron-refresh.sh` 安装为 root-only 可执行文件，通过 1Panel 或系统定时任务每日 `03:17` 运行。任务环境只提供 `CRON_SECRET`，可选设置 `PETRICHOR_CRON_BASE_URL`；失败必须进入 1Panel 告警，禁止把 Secret 打印到日志。

## Deep Research Worker

Worker 默认不启动，`PETRICHOR_DEEP_RESEARCH_ENABLED`、`PETRICHOR_DEEP_RESEARCH_WORKER_ENABLED` 及 Hybrid/Wiki/Graph flags 均保持 false。只有 expand-only Job 迁移已在 staging 执行、Postgres claim/lease/heartbeat/exactly-once 验收通过后，才可同时开启前两个 flags，并用 `docker compose --profile worker --env-file .env.production up -d web worker` 启动。Worker 只持久化 ID、hash、capability snapshot、租约、错误码和最终回答/安全引用；查询副本、chunk、snippet 和 RPC 结果不得进入 Job、Trace 或日志。

## 切换与回滚

Staging 验收通过后，将 Cloudflare DNS TTL 调整为 300 秒，再切换 `petrichor.genejm.one`。保留 Vercel Production 和原 Secret 48–72 小时；出现登录、S3、流式、GeneOps 或连接池异常时立即将 DNS 指回 Vercel，停止自托管容器，不执行数据库 down migration。
