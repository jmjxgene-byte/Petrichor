# Staging 验收记录

2026-09-10，Gene-OVH 使用 `982aa7e6a` 构建并启动 `petrichor-web:grounded-qa-982aa7e6a`。Bun 1.3.14 Debian 基础层固定为已核验 digest，构建依赖在 `--pull=false` 下从锁定缓存/registry 完成；镜像为 amd64，运行用户为 `bun`，根文件系统只读，仅绑定 `127.0.0.1:3001`。

为避免把生产数据库、S3 或会话密钥复制到 staging，本次使用 root-only、临时 SQLite 和随机 staging 密钥的隔离配置；GeneOps、Deep、Hybrid、Wiki、Graph 和 Worker 均关闭。staging OpenResty vhost 已在备份后仅将该域名代理到 3001，`nginx -t` 和 reload 通过，正式域名 vhost 仍代理 3000。

只读验收通过：`/healthz` 200、登录页 200、未授权 source-catalog 按方法门返回 405、HTML 使用 no-store 缓存头、容器 healthy 且重启次数为 0。浏览器演示模式验证了助手页面、全部资料/仅本地/知识库/文档库/实时外部来源分组、多选外部来源、范围文案和演示问答；未连接真实数据库、来源、模型或 S3，因此不替代生产数据链路验收。staging 容器和 vhost 保留供后续真实配置验收，临时 SQLite 数据随容器隔离。

生产迁移前的只读核对确认 `petrichor_schema_migration` 已执行至 `2026-09-01-deep-research-job.sql`，待执行且仅有 `2026-09-08-document-retrieval-index.sql` 与 `2026-09-10-site-branding.sql`。应用前已保存 public schema-only 备份。用户授权后两项迁移已在同一事务中完成，checksum 分别为 `2be024a85357b5818494e55cf06a1ab9d3a0783f7fbc60aedf3d2a789d3d88db` 与 `6c50c3da4de929b30af144957f4f2561c374fb9cfd3c6ddedc1ae8103001c0bf`；三张索引表、`branding_json`、RLS/ACL 和迁移总数 10 均通过只读核验。

随后以最新提交构建正式镜像 `petrichor-web:grounded-qa-3a068f87d`，在保留旧容器、旧镜像和脱敏回滚备份后替换正式 Web；新容器 healthy、只读根文件系统、非 root、无重启，六项 Deep/Hybrid/Wiki/Graph 开关为 false、Worker=0。正式域名 health/login/HTML no-store 和生产 vhost 静态资源 immutable 配置验收通过；未改变 DNS、S3、Vercel 或其他站点。
