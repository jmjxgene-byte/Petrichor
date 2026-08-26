import { z } from "zod"

export const ASSISTANT_SOURCE_KINDS = [
  "knowledge-base",
  "doc-library",
  "external-source",
] as const

export type AssistantSourceKind = (typeof ASSISTANT_SOURCE_KINDS)[number]
export const ASSISTANT_SOURCE_SELECTION_MAX = 20

export const assistantSourceRefSchema = z.string().trim().superRefine((value, ctx) => {
  if (!/^(knowledge-base|doc-library|external-source):[1-9]\d*$/.test(value)) {
    ctx.addIssue({ code: "custom", message: "资料源引用格式不合法" })
  }
})

const sourceRefsSchema = z.array(assistantSourceRefSchema).max(ASSISTANT_SOURCE_SELECTION_MAX).transform((values) =>
  [...new Set(values)].sort(),
)

export const assistantSourceScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("local") }),
  z.object({
    mode: z.literal("selected"),
    refs: sourceRefsSchema.refine((refs) => refs.length > 0, "至少选择一个资料源"),
  }),
])

export type AssistantSourceRef = z.infer<typeof assistantSourceRefSchema>
export type AssistantSourceScope = z.infer<typeof assistantSourceScopeSchema>

export type AssistantSourceAvailability = "ready" | "degraded" | "disabled"

export interface AssistantSourceCatalogItem {
  ref: AssistantSourceRef
  kind: AssistantSourceKind
  id: string
  name: string
  description: string | null
  availability: AssistantSourceAvailability
  selectable: boolean
  unavailableReason: string | null
  updatedAt: string
  capabilities: {
    sourceType?: string
    allowedSources?: string[]
    searchModes?: string[]
    graphEnabled?: boolean
    contractVersion?: number
    lastCheckedAt?: string | null
  } | null
}

export const DEFAULT_ASSISTANT_SOURCE_SCOPE: AssistantSourceScope = { mode: "all" }
export const LEGACY_ASSISTANT_SOURCE_SCOPE: AssistantSourceScope = { mode: "local" }

export function assistantSourceRef(kind: AssistantSourceKind, id: string | number): AssistantSourceRef {
  return assistantSourceRefSchema.parse(`${kind}:${String(id)}`)
}

export function parseAssistantSourceRef(ref: string): { kind: AssistantSourceKind; id: number } {
  const normalized = assistantSourceRefSchema.parse(ref)
  const separator = normalized.lastIndexOf(":")
  return {
    kind: normalized.slice(0, separator) as AssistantSourceKind,
    id: Number(normalized.slice(separator + 1)),
  }
}

export function normalizeAssistantSourceScope(value: unknown): AssistantSourceScope {
  return assistantSourceScopeSchema.parse(value)
}

export function assistantSourceScopeRefs(scope: AssistantSourceScope): AssistantSourceRef[] {
  return scope.mode === "selected" ? scope.refs : []
}

export function assistantSourceScopeFromFocus(focus: {
  sourceScope?: unknown
  knowledgeBaseId?: string | number | null
  libraryId?: string | number | null
} | null | undefined): AssistantSourceScope {
  if (focus?.sourceScope != null) {
    const parsed = assistantSourceScopeSchema.safeParse(focus.sourceScope)
    if (parsed.success) return parsed.data
  }

  const refs: AssistantSourceRef[] = []
  if (focus?.knowledgeBaseId != null) {
    refs.push(assistantSourceRef("knowledge-base", focus.knowledgeBaseId))
  }
  if (focus?.libraryId != null) {
    refs.push(assistantSourceRef("doc-library", focus.libraryId))
  }
  return refs.length > 0
    ? assistantSourceScopeSchema.parse({ mode: "selected", refs })
    : LEGACY_ASSISTANT_SOURCE_SCOPE
}
