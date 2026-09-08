import { and, count, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { withReadBudget } from "@/server/db/read-budget"
import { docDocuments, knowledgeBaseArticles } from "@/server/db/schema"
import { resolveAssistantSources } from "./source-catalog"
import type { AssistantFocus } from "./domain-types"

const total = z.number().int().nonnegative()
export const sourceStatisticsSchema = z.object({ rows: z.array(z.object({ name: z.string(), kind: z.enum(["knowledge-base", "doc-library", "external-source"]),
    total: total.nullable(), ready: total.nullable(), available: z.boolean() }).strict()) }).strict()

export async function readSourceStatistics(userId: number, focus: AssistantFocus | undefined, signal?: AbortSignal) {
    const scope = await resolveAssistantSources(userId, focus)
    const libraries = scope.selected.filter((source) => source.kind === "doc-library").map((source) => Number(source.id))
    const knowledge = scope.selected.filter((source) => source.kind === "knowledge-base").map((source) => Number(source.id))
    return withReadBudget(async (reader, checkpoint) => {
        const docs = libraries.length ? await reader.select({ id: docDocuments.libraryId, total: count(), ready: sql<number>`sum(case when ${docDocuments.status} = 'ready' then 1 else 0 end)`.mapWith(Number) })
            .from(docDocuments).where(and(eq(docDocuments.userId, userId), inArray(docDocuments.libraryId, libraries))).groupBy(docDocuments.libraryId) : []
        await checkpoint()
        const articles = knowledge.length ? await reader.select({ id: knowledgeBaseArticles.knowledgeBaseId, total: count() }).from(knowledgeBaseArticles)
            .where(and(eq(knowledgeBaseArticles.userId, userId), inArray(knowledgeBaseArticles.knowledgeBaseId, knowledge))).groupBy(knowledgeBaseArticles.knowledgeBaseId) : []
        return sourceStatisticsSchema.parse({ rows: [...scope.selected.map((source) => {
            const row = source.kind === "doc-library" ? docs.find((item) => item.id === Number(source.id)) : articles.find((item) => item.id === Number(source.id))
            return { name: source.name, kind: source.kind, available: true, total: source.kind === "external-source" ? null : row?.total ?? 0,
                ready: source.kind === "doc-library" ? docs.find((item) => item.id === Number(source.id))?.ready ?? 0 : null }
        }), ...scope.unavailable.map((source) => ({ name: source.name, kind: source.kind, available: false, total: null, ready: null }))] })
    }, { abortSignal: signal })
}

export function isSourceStatisticsQuestion(goal: string) {
    return /^(?:请问|请帮我看一下)?(?:当前|现在|这里|这个库|该库|本库|知识库|文档库|资料库)?(?:一共|总共)?(?:有多少|共有多少|多少)(?:篇|个|条|份)?(?:文档|文件|文章|帖子|回复)(?:(?:和|与|及)(?:文档|文件|文章|帖子|回复))?[？?。！!\s]*$/.test(goal.trim())
}
export function renderSourceStatistics(value: unknown) {
    const { rows } = sourceStatisticsSchema.parse(value)
    if (!rows.length) return "当前选定范围内没有可用资料源。"
    const escape = (name: string) => name.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&").replace(/[\r\n]/g, " ")
    return "当前选定资料范围的元数据统计（不是搜索命中数）：\n\n" + rows.map((row) => `- ${escape(row.name)}：${!row.available ? "当前不可用，总量未知" : row.total == null ? "外部源未提供总量接口，帖子与回复总量未知" : row.kind === "doc-library" ? `${row.total} 份文件，其中 ${row.ready} 份关键词就绪` : `${row.total} 篇文章`}`).join("\n")
}
