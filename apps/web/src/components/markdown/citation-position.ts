type PositionNode = { type: string; tagName?: string; children?: PositionNode[]; properties?: Record<string, unknown>; position?: { start: { offset?: number }; end: { offset?: number } } }

const blocks = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "li", "th", "td", "blockquote"])
/** 仅处理解析器提供的位置；在sanitize后添加受控属性，不解析正文里的HTML。 */
export function citationPosition(range: { start: number; end: number }) {
    return (tree: PositionNode) => {
        const visit = (node: PositionNode): boolean => {
            if (node.type !== "element") return false
            const childHit = (node.children ?? []).map((child) => visit(child)).some(Boolean)
            const start = node.position?.start.offset, end = node.position?.end.offset
            if (childHit || !blocks.has(node.tagName ?? "") || start == null || end == null || start >= range.end || end <= range.start) return childHit
            mark(node)
            return true
        }
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) return
        tree.children?.forEach(visit)
    }
}
function mark(node: PositionNode) {
    node.properties ??= {}
    node.properties.dataCitationHit = "true"
    const classes = node.properties.className
    node.properties.className = [...(Array.isArray(classes) ? classes : typeof classes === "string" ? [classes] : []), "bg-yellow-100/40", "ring-1", "ring-yellow-400/50", "scroll-mt-4"]
}
