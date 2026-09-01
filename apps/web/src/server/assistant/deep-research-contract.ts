import { createHash } from "node:crypto"
import type { AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
import { assistantSourceScopeFromFocus } from "@/lib/assistant-source-contract"
import type { ServerConfig } from "@/config/server"
import { deepResearchCapabilitySnapshotSchema } from "./deep-research-job-store"

export function buildDeepResearchCapabilitySnapshot(
    selected: AssistantSourceCatalogItem[],
    flags: ServerConfig["deepResearch"],
    capturedAt = new Date(),
) {
    const external = selected.find((item) => item.kind === "external-source")
    const capabilities = external?.capabilities
    const hasLocalSource = selected.some((item) => item.kind !== "external-source")
    const declaredModes = capabilities?.searchModes ?? (hasLocalSource ? ["exact"] : [])
    const allowedModes = declaredModes.filter((mode): mode is "exact" | "fuzzy" | "hybrid" => (
        mode === "exact" || mode === "fuzzy" || (mode === "hybrid" && flags.hybridEnabled)
    ))
    return deepResearchCapabilitySnapshotSchema.parse({
        contractVersion: capabilities?.contractVersion ?? null,
        sourceCutoffs: capabilities?.sourceCutoffs ?? {},
        allowedModes,
        wikiReady: flags.wikiEnabled && capabilities?.wikiReady === true,
        graphReady: flags.graphV2Enabled && capabilities?.graphReady === true,
        qualityStale: capabilities?.qualityStale === true,
        capturedAt: capturedAt.toISOString(),
    })
}

export function buildDeepResearchSourceScopeHash(focus: unknown) {
    const scope = assistantSourceScopeFromFocus(
        focus as Parameters<typeof assistantSourceScopeFromFocus>[0],
    )
    return createHash("sha256").update(JSON.stringify(scope)).digest("hex")
}
