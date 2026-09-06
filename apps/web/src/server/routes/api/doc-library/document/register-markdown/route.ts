// 独立路径让旧服务明确返回 404，避免回滚时把新客户端的元数据登记为空文档。
export { POST, maxDuration } from "../register/route"
