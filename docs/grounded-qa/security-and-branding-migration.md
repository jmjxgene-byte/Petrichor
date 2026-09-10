# 安全依赖与品牌迁移离线验收

2026-09-10，本轮仅处理依赖安全与本机合成数据库验收，没有生产、SSH、来源或模型调用。

## 依赖修复

保留现有override策略，固定以下版本并更新bun.lock，没有升级主版本：

| 依赖 | 原版本 | 新版本 | 修复依据 |
| --- | --- | --- | --- |
| @xmldom/xmldom | 0.8.x旧版本 | 0.8.15 | [xmldom公告](https://github.com/advisories/GHSA-965w-775f-mr7g) |
| js-yaml | 4.3.1 | 4.3.2 | [js-yaml公告](https://github.com/advisories/GHSA-2883-xcg3-v3hh) |
| sharp | 0.35.3 | 0.35.4 | [sharp公告](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) |
| next | 16.2.11 | 16.3.3 | [Next公告](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) |

Next来自传递peer，项目仍为Bun/Vite应用，已有postinstall移除未使用Next包的行为保持不变。不能仅凭依赖存在断言线上可利用；此处同时修复锁文件，避免后续安装带入已知风险版本。XML解析/序列化、YAML布尔和嵌套对象解析冒烟通过。

普通安装首次因默认临时目录权限失败；改用任务专用缓存和可写临时目录后成功，没有修改用户Shell/Git配置。`bun install --frozen-lockfile`通过，`bun audit --audit-level=high`退出0，先前2严重/10高危报告不再出现。依赖审计是当前数据库快照结果，不是永久无漏洞保证。

## 原生PG17离线验收

使用此前固定且本机已存在的PG17/pgvector和Bun镜像，内部网络、无发布端口、无业务挂载、无生产连接；QA_CANARY=false，未使用嵌入结果或调用模型。

客户端82项检查通过，宿主检查与清理通过：

- 固定旧Git基线8条migration，升级恰好2条（文档检索索引、站点品牌），ledger总数10。
- 注入迁移失败时新表、新品牌列、DML和ledger全部回滚。
- 升级保留旧用户与publicQaEnabled=false，branding_json缺省为{}。
- runtime可保存/读取品牌配置，anon/authenticated/service_role无新列读取权限，应用表RLS保持启用。
- 第二次bootstrap安全拒绝，重复migrate为0条。
- 原生向量、词法锚点、权限、generation、Deep与索引任务状态机回归通过。
- 临时两个容器、内部网络和基线源码副本均清理；独立资源列表复核无本测试标签残留。

全量1622测试通过/40既有跳过，typecheck/lint/build/diff通过，既有大chunk构建提示保留。此次解除本地依赖安全与新增迁移验收阻塞；不是生产迁移或Staging发布，也未完成全部检索质量/人工60题验收。
