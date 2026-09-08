# 依赖门禁核验

2026-09-08，源码提交c6fcf333337be8261b31d1e42e0524b657ba4b3f，Bun 1.3.14。冻结安装首次临时目录PermissionDenied；仅本次进程设置TMPDIR=/private/tmp及BUN_INSTALL_CACHE_DIR=/private/tmp/petrichor-upload-bun-cache后，`bun install --frozen-lockfile`退出0，项目postinstall正常完成。未修改锁文件、依赖版本或全局配置，工作区保持干净。该操作使用现有工作树，不等同于全新机器冷启动验证。

安装后重新执行：1459测试通过、40既有跳过，typecheck、lint、build、diff检查及`bun audit --audit-level=high`均退出0。完整`bun audit --json`退出1，包含7个包、11条低/中风险通告；高危门通过不能表述为依赖无漏洞。

| 包 | 本次通告严重度 | 后续调查 |
|---|---|---|
| @ai-sdk/provider-utils | low | 核对旧版实例的实际导入路径 |
| @xmldom/xmldom | moderate | 核对XML序列化调用及输入来源 |
| decode-uri-component | moderate | 核对不可信编码输入可达性 |
| esbuild | low/moderate | 区分版本与开发服务器暴露条件 |
| js-video-url-parser | moderate | why确认0.5.1经@platejs/media引入；核对媒体URL输入边界 |
| qs | moderate（2条） | why确认6.15.3经Express/body-parser及MCP SDK链引入；不因此假定应用启用了Express解析器 |
| undici | moderate（3条） | why确认6.27.0经cheerio/juice到Plate导入组件；另有7.29/8.10实例，不混为一个版本 |

未执行漏洞利用探针、未修改审计忽略列表，未升级整套依赖。依赖树只能证明安装关系，不能证明漏洞生产可达或不可达；后续按调用路径、官方通告和兼容性逐项处理。本报告不是安全审计完成证明，也不替代真实检索/费用/PG/部署门。
