import { toKeywordQuery } from "@/server/retrieval/query-rewrite"

export type GroundingPolicy = "required" | "exempt" | "action"

/** 豁免只接受完整、明确的请求，不让模型的意图标签覆盖资料约束。 */
export function groundingPolicy(goal: string): GroundingPolicy {
    const text = goal.trim()
    if (/^(?:你好|您好|嗨|hello|hi|谢谢|感谢|再见)[！!。,.，\s]*$/i.test(text)) return "exempt"
    if (/^(?:请|帮我)?(?:把|将).{1,100}(?:翻译成|译成)(?:中文|英文|英语|日语|法语|德语)[。！!\s]*$/.test(text)
        || /^(?:请|帮我)?翻译[：:]\s*\S/.test(text)) return "exempt"
    if (/^(?:请|帮我)?(?:把|将)(?:上面|上一条|刚才)(?:的)?(?:回答|内容)(?:改成|整理成)(?:列表|表格|分点)[。！!\s]*$/.test(text)) return "exempt"
    if (/^(?:请|帮我)?(?:创建|新建|删除|重命名|移动|上传|导出)(?:一个|一篇|这个|这篇|该)?(?:知识库|文档库|文件夹|文章|文档|文件)(?:[：:\s].+|[。！!]*)$/.test(text)
        && !/[？?]|(?:如何|怎么|能否)/.test(text)) return "action"
    return "required"
}

export function groundingQueries(goal: string): string[] {
    const original = goal.trim().slice(0, 400)
    const keyword = toKeywordQuery(original)
        .replace(/(?:怎么|如何|怎样)(?:操作|处理|做|翻|弄)?[？?。！!\s]*$/, "")
        .trim()
    return [...new Set([original, keyword].filter(Boolean))].slice(0, 2)
}

export const GROUNDED_ANSWER_GUIDANCE = `当前为资料优先问答。你只能依据本轮已读取的资料支持业务结论。
范围选择不是一般背景：不得自行跨库、联网或补入常识。引用只使用本轮实际证据。
问题存在关键歧义时先问一句澄清；“怎么翻”不等于“翻译”。资料不支持的部分明确说明不足。
群聊经验不等于官方规则，未知时间不用于断言最新。`

export function insufficientGroundingAnswer(unavailable: boolean): string {
    return unavailable
        ? "当前资料检索未能完成，我不能据此给出业务结论。请稍后重试，或选择其他可用资料源。"
        : "我已检索当前选择的资料，但还没有读到足够依据。请补充具体对象或场景，我再继续查找；不会用通用知识代替资料结论。"
}
