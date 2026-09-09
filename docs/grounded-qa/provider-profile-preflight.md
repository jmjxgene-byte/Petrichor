# Provider配置元数据核验准备

2026-09-09：`canary-credential-bridge.ts`拆出`readCanaryProviderProfile`。在READ ONLY / REPEATABLE READ事务中确认runtime角色、隔离级别、管理员用途绑定、四层归属、BGE-M3/1024、启用状态及固定endpoint；不选择api_key_enc。URL及headers仅返回SQL判断的布尔值，不返回自定义内容。输出为固定能力字段与providerProfileHash，不含凭证ID、密文或明文。

真正执行路径复用相同元数据查询和指纹算法；期望指纹匹配后才在同一事务中读取唯一密文，事务结束后解密使用。配置或归属失配时不读密文。现有合成bridge fixture同步调整，没有重跑远端演练。

新增`canary-profile-entry.ts`，默认仅预检；执行要求独立profile UUID、入口SHA、受控Linux UID1000私有目录、明确用户ID及--read-profile-approved。执行一次性预约不自动重试，DATABASE_URL仅在进程内使用，不导出；脚本没有provider请求或解密入口。准备好的profile bundle SHA为 `384b7ed1aca41dc8c5bce4126660c87ce51cbcdd13ae3b252358a4a06a68e347`，本地源码和bundle预检均报告0数据库/模型调用。

验证：12项mock事务定向测试通过，全量1598通过/40既有跳过，typecheck/lint/build/diff通过，构建大chunk提示保留。数据库SQL尚未在真实Postgres执行；不能将mock测试称为生产配置核验。连接行为继续遵循现有prepare:false约束，参考[Supabase连接文档](https://supabase.com/docs/guides/database/connecting-to-postgres)。本轮无迁移、授权变更、远端部署、真实数据库或模型调用。

下一门仅申请一次生产配置元数据只读核验，限定当前用户和用途，不读取API Key密文/明文、不调用provider。成功后固定profile指纹，另行授权新的真实模型批次。凭证桥接代码改变，旧9300e7b9生产入口bundle仅为历史预检产物；新真实批次必须重新构建和固定其SHA，不能混用旧身份。

## 一次真实只读核验结果

同日用户确认继续后，先补同事务的具名管理员唯一匹配，避免把合成测试userId=1误当生产身份；未匹配或重名时停止。profile入口支持具名选择，新包SHA `471d76a1b5c99a16c9be4e177fda12c203e3a63ea7fe67ccdb1a99b30691186a`。

本机启动器首次因URL pathname未解码而找不到中文路径，在预约、SSH和数据库访问之前失败；改用fileURLToPath并确认无started标记后执行尚未消耗的唯一核验。结果configurationValid=true，BGE-M3/1024与固定provider、启用状态、绑定归属和只读/隔离级别门均通过；模型调用0、密文读取false。真实profile指纹仅留私有报告，不写入公开报告。临时工具已删除，另一次只读检查确认目录不存在；Web健康、镜像和启动实例未变。

最新14项定向、全量1600通过/40既有跳过，typecheck/lint/build/diff通过。此结果只证明配置和SQL契约，不证明Key有效、模型可达、余额充足或检索质量；真实模型批次尚未开始。下一步为新身份、固定profile与新入口SHA的有限嵌入验收，仍需独立模型调用授权，不复用旧失败批次。
