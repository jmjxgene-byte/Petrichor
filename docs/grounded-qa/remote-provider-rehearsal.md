# 远端假provider端到端演练

2026-09-09，沿用已授权root-only临时合成目录，不读取真实凭证/环境，不连接数据库或模型，不修改生产Web。

## 链路与结果

`verify-canary-spool-remote.ts --synthetic-only-approved --fake-provider` 打包纯测试入口，校验bundle后执行：假数据库只读凭证桥接 → 假provider 22次嵌入/8次重排 → 逐响应持久化 → 不提供Key的重复读取 → 产物分块 → 受控截断拒绝 → 缺块补传 → 整体SHA → 清理。

最终演练结果：simulatedRequests=30，recoveredWithoutInvocation=true，真实modelCalls=0、databaseCalls=0。脱敏后的聚合产物1118398字节、35块，先接收2块，故意截断的第3块被拒绝，再仅补传33块；最终SHA `68588bd191fd0b760392198d176e56b00324337c2c003621ee4a0c58dab334ca` 一致。remoteCleaned/localCleaned均true，仅保留本地安全报告。

此前同路径未接假凭证桥接时也通过，SHA不同是因为产物包含独立执行身份和档案hash，不以两次SHA相同为验收要求。上述是最终桥接演练收据，不是模型质量指标。

## 只读凭证桥接代码

`withCanaryCredential`由调用方提供受控runtime连接和解密回调，不自行读取env或建立管理连接。SQL使用READ ONLY+REPEATABLE READ，8秒statement timeout/1秒lock timeout；核验runtime角色、只读状态、超级管理员用户及binding/model/provider/credential四层归属、BGE-M3/1024维/启用状态、固定硅基流动端点和空额外headers。事务结束后才解密，将Key仅交给受信任回调，回调只能返回安全结果，不得外发Key。

档案hash包含模型/provider/credential身份和更新时间；调用方可提供冻结hash，变化时在解密前拒绝。数据库/解密失败和后续执行失败使用不同固定错误类别，无原始异常或凭证。该桥接仅完成假数据库测试和假凭证远端接线，未读真实凭证，也未验证真实数据库中的当前绑定。

最终全量1571通过/40既有跳过，类型/Lint/build/diff通过。远端演练包含假凭证桥接，新增冻结hash拒绝路径另由本机假数据库测试覆盖，不将其宣称为真实数据库验收。

## 尚未完成

这不是新的真实canary。两批旧失败记录及授权保持不变；真实模型调用仍需独立批准新执行身份、固定档案、调用上限及受限落盘位置。新生产执行入口需要确保密钥始终留在其已有受控环境，不得为方便把Key传给宿主编排器或写入文件。此边界未实际接入前，旧stdout真实执行入口继续禁用。

下一步先以只读方式核验新的凭证桥接和执行环境设计，明确模型进程的落盘位置与分块读取方式，再申请完整真实canary；模型质量、人工60题、Staging与正式部署门仍未通过。
