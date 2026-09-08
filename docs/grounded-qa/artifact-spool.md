# 可恢复产物分块与收据（本机与远端合成验证）

2026-09-09。此模块只操作调用方指定的受限本地目录；没有模型、数据库、SSH或自动重试入口，尚未接入真实canary生产过程。

## 契约

- 最大4MiB产物，按32KiB拆分；manifest严格绑定executionId、planHash、总字节/SHA及连续块索引、字节/SHA。
- 文件名由代码按数字索引生成，不接受manifest中的任意路径。目录0700、文件0600；拒绝符号链接及宽权限目录/文件。
- 块验证通过才写入同目录临时文件，fsync后用硬链接无覆盖发布，并同步父目录。相同内容重复提交幂等，冲突拒绝，不覆盖已有产物。
- 恢复时从manifest重新校验已有块，只返回缺失索引；损坏块是失败，不静默删除或自动补传。未发布的pending文件不算收到。
- 全部块与整体SHA验证后才发布artifact.bin和receipt.json；缺块、整体hash不符或已有产物冲突不会发布成功收据。调用方不能只信收据布尔值，消费前仍应核对完整性及业务schema。
- 传输恢复只重读已生成块，不重新调用模型。模型执行授权、逐请求落盘和失败终态仍是独立职责；本模块不使旧canary恢复为可执行。

## 本机实测

`bun run --cwd apps/web ./scripts/verify-canary-spool-local.ts` 创建1680201字节虚构JSON，分为52块，先接收2块；独立Bun进程只读取发送目录的50个缺失块并完成校验，无重新生成或网络请求。完整SHA为 `c62c801e6f2376a5cdb06fd85c9bb77a22d6cd41ad2a31f77390ac9dce5e8968`，passed=true、cleanupOk=true、模型/数据库调用0。

8项测试覆盖补块/乱序/幂等、损坏/截断、跨执行与计划冲突、危险ID/布局、存量块篡改、符号链接/权限、总hash错误、孤立pending及不覆盖冲突产物。首轮一项错误类别不符：已有manifest长度大于新内容时误报unsafe_spool_file；现在明确分类spool_file_conflict，拒绝行为未放宽。

这是模拟中断点后的跨进程恢复，不是实际断电或远端网络演练，不是完整canary已修复。旧两批标记和失败产物未动，生产未部署。

## 已授权远端合成演练

2026-09-09用户单独批准后，`verify-canary-spool-remote.ts` 将纯文件测试工具bundle核验SHA后放入独立root-only临时目录，使用既有Node执行，不进入生产Web进程或读取其env。合成产物仅生成一次；远端保存52块及manifest/收据，本地先接收2块，故意返回的截断第3块被拒绝，重新打开manifest后只读取50个缺失块。每个块使用独立小于64KiB的回传响应，接收端再次校验长度/SHA，未重新生成产物。

实测passed=true、bytes=1680201、blocks=52、resumedBlocks=50、partialRejected=true，完整SHA仍为 `c62c801e6f2376a5cdb06fd85c9bb77a22d6cd41ad2a31f77390ac9dce5e8968`。远端按随机UUID和root owner标记核验后精确删除临时目录，remoteCleaned=true；本地接收目录删除，localCleaned=true，仅保留安全聚合报告。模型/数据库调用0，无凭证读取、Web配置/镜像/挂载或重启变更。

全量回归1530通过/40既有跳过，类型/Lint/build通过。演练模拟块截断与恢复，不是真实网络故障或系统断电证明；真实provider每次响应的持久化尚未接线，两次旧canary失败标记不动。

下一步在离线代码中接入逐模型响应落盘与执行收据，使传输恢复不再重复调用模型；真实模型批次仍需独立批准新的身份和调用上限，不能沿用已经消耗的旧授权。
