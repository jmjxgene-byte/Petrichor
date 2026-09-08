import { assistantFocusSchema } from "./thread-logic"

/** 空范围是旧协议；损坏或不兼容的范围不是空范围，不能悄悄扩大查询。 */
export function parseDeepResearchFocus(value: string | null) {
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    if (parsed === null) return null
    return assistantFocusSchema.parse(parsed)
}
