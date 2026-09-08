import { z } from "zod"
import { GROUNDING_CLARIFICATION, insufficientGroundingAnswer } from "./grounding-policy"

const resolutionSchema = z.object({ groundingStatus: z.enum(["insufficient", "clarification", "time_unknown", "conflict"]) }).strict()

/** 模型只能选择弃答原因；提示由服务端产生，不接受随附结论或原始正文。 */
export function parseGroundedResolution(raw: string) {
    if (raw.length > 160) return null
    let value: unknown
    try { value = JSON.parse(raw) } catch { return null }
    const parsed = resolutionSchema.safeParse(value)
    if (!parsed.success) return null
    const status = parsed.data.groundingStatus
    const answer = status === "clarification" ? GROUNDING_CLARIFICATION
        : status === "time_unknown" ? "当前来源的时间信息不足，我无法据此确定最新版本或事件先后。请补充带有可验证发布时间的资料，或限定具体版本后再查询。"
        : status === "conflict" ? "本次读取的资料存在尚未核实的冲突，我暂不能选定其中一种说法作为结论。请补充权威依据或适用版本，我再继续核对。"
        : insufficientGroundingAnswer(false)
    return { status, answer }
}

export const GROUNDED_RESOLUTION_GUIDANCE = `在写答案前判断已读资料是否足以回答当前问题。
若不足，不要为了格式要求给无依据结论加引用，也不要附带常识答案。只输出以下一种JSON对象，禁止Markdown围栏和额外字段：
{"groundingStatus":"insufficient"}：内容不支持所问结论。
{"groundingStatus":"clarification"}：对象或语义仍不明确。
{"groundingStatus":"time_unknown"}：问题依赖最新/先后/适用日期，但来源时间不可验证。
{"groundingStatus":"conflict"}：已读来源冲突，无法有依据地裁定。
只有资料充分时才输出正常Markdown答案及本轮原文引用；判断充分不等于来源权威，不能把经验升格为官方规则。`
