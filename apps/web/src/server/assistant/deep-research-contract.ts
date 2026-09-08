import { createHash } from "node:crypto"
import type { AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
import { assistantSourceScopeFromFocus } from "@/lib/assistant-source-contract"
import type { ServerConfig } from "@/config/server"
import { deepResearchCapabilitySnapshotSchema, type DeepResearchCapabilitySnapshot } from "./deep-research-job-store"
import type { DeepResearchCandidate } from "./deep-research-pipeline"

export function buildDeepResearchCapabilitySnapshot(
    selected: AssistantSourceCatalogItem[],
    flags: ServerConfig["deepResearch"],
    capturedAt = new Date(),
) {
    const sources = selected.map((source) => {
        const capabilities = source.capabilities
        const qualityStale = capabilities?.qualityStale === true
        const declared = source.kind === "external-source" ? capabilities?.searchModes ?? [] : ["exact"]
        return { sourceRef: source.ref, kind: source.kind, contractVersion: capabilities?.contractVersion ?? null,
            sourceCutoffs: capabilities?.sourceCutoffs ?? {}, qualityStale,
            wikiReady: !qualityStale && flags.wikiEnabled && capabilities?.wikiReady === true,
            graphReady: !qualityStale && flags.graphV2Enabled && capabilities?.graphReady === true,
            allowedModes: qualityStale ? [] : declared.filter((mode) => mode === "exact" || mode === "fuzzy" || (mode === "hybrid" && flags.hybridEnabled)) }
    }).sort((a, b) => a.sourceRef < b.sourceRef ? -1 : a.sourceRef > b.sourceRef ? 1 : 0)
    const allowedModes = [...new Set(sources.flatMap((source) => source.allowedModes))].sort()
    const single = sources.length === 1 ? sources[0] : undefined
    return deepResearchCapabilitySnapshotSchema.parse({
        reservationVersion: 1,
        sources,
        // 根字段仅作旧读取器兼容摘要，不能再代表某一个外部源。
        contractVersion: single?.contractVersion ?? null,
        sourceCutoffs: single?.sourceCutoffs ?? {},
        allowedModes,
        wikiReady: sources.some((source) => source.wikiReady),
        graphReady: sources.some((source) => source.graphReady),
        qualityStale: sources.length > 0 && sources.every((source) => source.qualityStale),
        capturedAt: capturedAt.toISOString(),
    })
}

export function deepResearchModeFocuses(snapshot: DeepResearchCapabilitySnapshot, originalFocus: unknown, mode: "exact" | "fuzzy") {
    if (!snapshot.sources) return [originalFocus]
    const refs = snapshot.sources.filter((source) => !source.qualityStale && source.allowedModes.includes(mode)).map((source) => source.sourceRef)
    // all范围可超过单次自选上限；分批完整覆盖，不截断到前20个来源。
    return Array.from({ length: Math.ceil(refs.length / 20) }, (_, index) => ({ sourceScope: { mode: "selected" as const, refs: refs.slice(index * 20, index * 20 + 20) } }))
}

export async function searchDeepResearchMode(snapshot: DeepResearchCapabilitySnapshot, focus: unknown, mode: "exact" | "fuzzy", signal: AbortSignal,
    search: (focus: unknown) => Promise<{ candidates?: DeepResearchCandidate[]; degradedSources?: unknown[] }>) {
    const candidates: DeepResearchCandidate[] = []
    let degradedSourceChecks = mode === "exact" ? snapshot.sources?.filter((source) => source.qualityStale).length ?? 0 : 0
    let failedSearches = 0
    for (const modeFocus of deepResearchModeFocuses(snapshot, focus, mode)) {
        signal.throwIfAborted()
        try {
            const output = await search(modeFocus)
            candidates.push(...(output.candidates ?? []))
            degradedSourceChecks += output.degradedSources?.length ?? 0
        } catch {
            signal.throwIfAborted()
            failedSearches += 1
        }
    }
    candidates.sort((a, b) => b.score - a.score || (a.candidateKey < b.candidateKey ? -1 : a.candidateKey > b.candidateKey ? 1 : 0))
    return { candidates, degradedSourceChecks, failedSearches }
}

export function buildDeepResearchSourceScopeHash(focus: unknown) {
    const scope = assistantSourceScopeFromFocus(
        focus as Parameters<typeof assistantSourceScopeFromFocus>[0],
    )
    return createHash("sha256").update(JSON.stringify(scope)).digest("hex")
}
