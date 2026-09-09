# 受控命令适配器：本地协议链验收

2026-09-09：`canary-command-port.ts`连接宿主控制器接口与既有runtime五项命令。生产命令执行器使用execFile参数数组，无shell、无自动重试、不传运行时凭证；固定容器ID、UID1000和基于UUID的entry.js路径。每次动作前后核验容器ID/image/StartedAt/running，执行前status核对入口SHA、计划、请求集和provider profile。执行超时45秒，其他命令10秒，输出上限64KiB；原始stderr不向上返回。真实runtime status同步返回这些安全身份字段。

4项新增本地测试覆盖宿主→命令协议→合成产物→分块收据→ACK完整交接、ACK异常恢复、容器/代码身份漂移、超限/非单一JSON、错误脱敏及参数注入拒绝。合成执行一次，ACK恢复不新增执行。本次runner为注入模拟器，没有真正启动Docker命令、SSH、数据库或模型，因此不构成真实进程timeout/网络故障或服务器验收。

全量1594通过/40项既有跳过，typecheck/lint/build/diff通过，既有大chunk警告保留。更新后的runtime bundle本地预检通过，SHA `9300e7b9ea6dbde697fed7dd890ac72dffb46dd4bb3f094e363f94e2ece86721`；此前01570346开头bundle仅为旧验证产物，不能与当前status契约混用。请求集仍固定14+8次嵌入，未加入重排，未创建新真实批次授权。

下一门：冻结宿主/入口包，另行批准在现有隔离临时位置进行仅合成数据、零服务的真实命令演练，确认Docker执行、权限、输出和清理。随后才核验真实profile与申请新批次。不得把旧失败canary标记删除后重跑；宿主持久身份和日志必须保留，不能重建同一已消费身份。未部署应用，MVP质量验收仍未完成。

## 独立进程补充验证

同日新增仅测试的`fixtures/canary-command-process.mjs`。每次协议调用均通过execFile启动独立本机进程，使用私有测试目录保存合成响应和ACK，子进程不继承业务环境变量。第一轮完成产物持久化并写入ACK后退出7，模拟ACK返回丢失；创建新的port后恢复成功，未再执行execute-one，也未重复下载已保存块。总执行次数1，结果文件保持0600，测试结束自动删除本阶段临时目录。此为真实本机子进程、模拟Docker协议；没有实跑Docker/SSH，也不证明断电fsync或真实网络故障恢复。

最新定向5项通过，全量1595通过/40既有跳过，typecheck/build通过；Lint最初因mjs未显式导入process/Buffer失败，补标准库import后Lint和定向回归通过，未放宽规则。生产入口bundle未改变，仍使用上文9300e7b9开头SHA。旧remote handoff演练入口未接入新command-port，不能以旧演练成功替代本节点远端验收。
