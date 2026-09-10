# 重排配置安全快照

2026-09-10：新增 `canary-rerank-profile.ts`，把 Rerank 配置转为安全快照，只保留启用状态、provider、模型、候选上限、HTTPS 地址主机、超时和 `apiKeyPresent`，不返回或哈希 API Key。URL 拒绝明文 HTTP、账号密码、query/hash 和危险协议；候选上限 1–20，超时 1–20 秒。

真实 canary 额外要求启用、模型为 `BAAI/bge-reranker-v2-m3`、HTTPS 地址和 Key 存在；profile hash 只由安全快照计算。当前未读取生产环境或数据库，`rerankerProfileVerified` 仍为 false；不能用 embedding 配置指纹代替 rerank profile。

本阶段只完成纯函数测试，真实配置核验及模型调用仍需独立授权。任何配置失败应停在 profile 门，不生成重排请求、不连接 provider；通过后还需保留 8 条请求的逐项 ACK 和安全结果消费契约。

当前应用仍以 `RAG_RERANK_ENABLED=false` 为默认值；本地配置的 `RAG_RERANK_API_KEY` 不参与快照输出。profile 核验通过不等于余额、网络或模型服务可用，真实调用的失败必须落入现有本地 fallback。
