# Production 发布记录

2026-09-10，用户确认后应用两个 expand-only migration：`2026-09-08-document-retrieval-index.sql` 与 `2026-09-10-site-branding.sql`。执行前 public schema-only 备份 SHA 为 `e1242b6a61b1badcce84f6daf4f9517cddb29eac162b395e712309fdd77db4ef`，备份保存在 Gene-OVH root-only backups。迁移使用专用 migrator 连接，在单事务中完成；两项 checksum 分别为 `2be024a85357b5818494e55cf06a1ab9d3a0783f7fbc60aedf3d2a789d3d88db` 与 `6c50c3da4de929b30af144957f4f2561c374fb9cfd3c6ddedc1ae8103001c0bf`。只读复核确认三张索引表、`branding_json`、RLS/ACL 均存在且迁移台账总数为 10。

使用最新已推送提交 `3a068f87d` 构建 `petrichor-web:grounded-qa-3a068f87d`，Bun 基础层固定为 Gene-OVH 已核验 digest。生产替换前保存旧容器的脱敏运行参数、旧 Compose 和旧镜像回滚 tag `petrichor-web:rollback-0344a485f`。新容器 `petrichor-web-1` 运行于 `127.0.0.1:3000`，用户为 `bun`、根文件系统只读、restart=unless-stopped，健康检查通过且重启次数为 0；Deep Research、Hybrid、Wiki、Graph 开关保持关闭，Worker 数量为 0。

正式域名只读验收通过：`/healthz` 返回 200，登录页返回 200，HTML 使用 no-store，生产 Nginx vhost 的静态资源规则保持 immutable。staging 仍独立运行于 3001，正式 vhost 未改代理端口；未修改 Cloudflare DNS、S3、Vercel Production 或其他站点。真实登录后的 2FA、S3 上传/删除、GeneOps 实时查询及 60 题人工支持度尚未在本次发布中执行，不能将健康检查等同于完整业务验收。

回滚方式：停止并移除新 Web，使用旧 Compose 与 `petrichor-web:rollback-0344a485f` 恢复 3000 端口；必要时将正式域名切回保留的 Vercel 部署。数据库采用前向修复，不回滚或删除新表/列。
