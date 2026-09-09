# 运行时→宿主两级交接（合成验证）

2026-09-09，用户批准仅在容器临时目录和宿主root-only目录放置合成数据/测试工具。运行时使用当前非root UID私有0700目录，宿主使用独立UUID的root-only目录；不读取真实凭证或数据库，不调用模型，不改配置/镜像/挂载/端口/flags或重启服务。

## 实现与时序

逐调用日志及provider适配器新增`afterPersist`交接回调，当前响应和收据完成后执行；回调未确认则返回`handoff_unconfirmed`，保留已持久化结果，不进入下一调用，也不删除预约以重获执行权。远端运行必须提供该回调，本机同一持久化域可省略。

合成工具`remote-handoff-synthetic-agent.ts`分宿主控制与运行时动作，使用相同已校验bundle：

1. 运行时产生第0项假响应并落盘，因无ACK停止；模拟调用数1。
2. 宿主逐块取回、验证并写入自己的完整产物/收据，故意丢弃ACK。
3. 再次执行仍停在第0项、调用数仍1，第1项没有被执行。
4. 仅恢复ACK交接，验证调用数仍1；然后显式继续演练，才允许第1项假调用。
5. 第1项完成相同交接后，再次读取全批成功且模拟调用数仍为2。

ACK包含执行身份、manifest hash、产物hash和字节数，并与运行时完整收据逐字核对，通过后才无覆盖发布ACK文件。宿主控制通道是受信任操作环境；本机制不是针对恶意root的认证系统，也不把传输恢复当作模型重试授权。

## 实测

- passed=true，simulatedInvocations=2，ackLossBlockedNext=true，recoveryInvocations=0。
- 两项产物各180023字节，SHA分别为：
  - `9d967e8abd39b7d9e5c202a39b75e0ec65e87c37c414ba21069d75e48338659f`
  - `457ee84a751989a3f62bb86ec29c9139d3e8a69985092d4cdaee7df31c2bd86f`
- runtimeCleaned、remoteCleaned、localCleaned均true；webHealthy、webImageUnchanged均true。
- 真实模型/数据库调用均0，控制进程退出0；只保留本地安全聚合报告。

这是主动遗漏ACK的受控演练，不是实际网络故障或容器崩溃测试。真实provider入口仍未启用，旧两批失败标记和产物保持不变。下一步按同一交接协议构建真实入口，先做不调用模型的预检，再单独批准新批次身份和范围。
