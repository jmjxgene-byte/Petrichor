# 单项运行时入口：本地预检

2026-09-09：新增 `canary-runtime-entry.ts`，仅在本地验证，未向服务器传输或执行。`--preflight` 不读取凭证、不访问数据库或模型；固定计划包含14次文档嵌入和8次查询嵌入，不含重排。执行与恢复分为 execute-one/status/manifest/block/ack，取回和ACK要求已持久化产物完整性验证，不能隐式触发调用。指定单项执行要求此前全部结果持久化且有宿主ACK；未知结果禁止重试。请求使用与provider一致的规范JSON，避免字段顺序导致journal哈希漂移。

新执行要求独立execution UUID、代码SHA、plan/request-set/profile哈希、用户身份、22次上限和有效截止时间。过期许可仅可用于读取和ACK；不得自动创建新许可，不得复用此前失败批次。容器临时目录或journal丢失后不能以相同许可重新初始化，宿主控制器仍需验证生命周期和不可重试终态。

本地源码及Bun bundle预检输出相同，request-set SHA为 `66404b7397f87bb59f3e10bd3d0d07ffd8dfe3eb84f60601923001468f624c94`，本次bundle SHA为 `01570346a01f61757012c1ad64735b425573a4f87c04e487be8902a75b1c4674`。产物仅保留在忽略目录，目录0700、文件0600，不提交bundle或授权文件。43项定向测试通过；全量1582通过、40项既有跳过；typecheck/lint/build/diff检查通过，构建仍有大chunk提示。

尚未验证Linux运行时真实凭证桥接、真实调用、宿主调度全链路或网络中断；未运行真实canary、索引或部署。下一步先补宿主执行控制与零服务集成测试，再单独确认真实profile和新批次授权；这些预检不构成MVP质量验收。
