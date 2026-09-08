import { createHash } from "node:crypto"
import { normalizeDeepEvidenceUrl } from "@/lib/deep-evidence-url"
import { validateGroundedCitations } from "./agent-runtime/grounded-citations"

import type { AgentEvidence, AgentEvidenceSource } from "./agent-runtime/types"
import type { DeepResearchFinalMessage } from "./deep-research-job-store"
import type { DeepResearchEvidence } from "./deep-research-pipeline"

export function buildDeepResearchReferenceKey(input: {
    source: string
    title: string
    url: string | null
    fallbackKey: string
}) {
    const safe = normalizeDeepEvidenceUrl(input.url, input.source)
    const canonical = safe?.startsWith("/") ? safe : safe ? canonicalHttpUrl(safe) : null
    if (canonical) return `url:${canonical}`
    const fallback = input.fallbackKey.trim()
    if (fallback) return `source:${input.source}:${fallback}`
    return `title:${input.source}:${normalizeTitle(input.title)}`
}

export function normalizeDeepResearchUrl(raw: string | null, source?: string) {
    return normalizeDeepEvidenceUrl(raw, source)
}

export function deepResearchCitationIndices(evidence: DeepResearchEvidence[]) {
    const indices = new Map<string, number>()
    return evidence.map((item) => {
        const url = normalizeDeepEvidenceUrl(item.url, item.source)
        let key = item.referenceKey
        if (url?.startsWith("/")) {
            const parsed = new URL(url, "https://petrichor.invalid")
            key = `${item.source}:${parsed.pathname}:${parsed.searchParams.get("documentId") ?? ""}`
        }
        if (!indices.has(key)) indices.set(key, indices.size + 1)
        return indices.get(key)!
    })
}

export function validateDeepResearchCitations(answer: string, evidence: DeepResearchEvidence[]) {
    const indices = deepResearchCitationIndices(evidence)
    return validateGroundedCitations(answer, new Set(indices.filter((_index, position) => evidence[position].content.trim().length > 0)))
}

export function normalizeDeepResearchAnswer(value: string) {
    let answer = value.trim()
    const leadingTitle = /^(?:#{1,6}\s*)?深度检索补充\s*(?:[:：-]\s*)?(?:\r?\n|$)/u
    while (leadingTitle.test(answer)) answer = answer.replace(leadingTitle, "").trimStart()
    return answer.trim()
}

export function toDeepResearchReferences(
    evidence: DeepResearchEvidence[],
): DeepResearchFinalMessage["deepResearch"]["references"] {
    const indices = deepResearchCitationIndices(evidence)
    const hasLocal = evidence.some((item) => item.url?.startsWith("/"))
    return evidence.map((item, index) => ({
        title: item.title.slice(0, 500),
        url: normalizeDeepEvidenceUrl(item.url, item.source),
        source: (item.sourceName?.trim() || item.source).slice(0, 100),
        sourceKind: normalizeAgentEvidenceSource(item.source),
        ...(hasLocal ? { citationIndex: indices[index] } : {}),
        queriedAt: item.queriedAt,
    }))
}

export function toMetadataOnlyAgentEvidence(
    evidence: DeepResearchEvidence[],
    now = Date.now(),
): AgentEvidence[] {
    const indices = deepResearchCitationIndices(evidence)
    return evidence.map((item, index) => ({
        id: `deep_${createHash("sha256").update(item.referenceKey).digest("hex").slice(0, 24)}`,
        source: normalizeAgentEvidenceSource(item.source),
        title: item.title,
        content: "",
        ...(normalizeDeepEvidenceUrl(item.url, item.source) ? { url: normalizeDeepEvidenceUrl(item.url, item.source)! } : {}),
        metadata: {
            sourceName: item.sourceName?.trim() || item.source,
            queriedAt: item.queriedAt,
            citationIndex: indices[index],
            persistedMetadataOnly: true,
        },
        createdAt: now + index,
    }))
}

function normalizeAgentEvidenceSource(value: string): AgentEvidenceSource {
    switch (value) {
        case "knowledge":
        case "document":
        case "wiki":
        case "web":
        case "memory":
        case "graph":
        case "tool":
        case "subagent":
        case "geneops":
            return value
        default:
            return "tool"
    }
}

function canonicalHttpUrl(raw: string) {
    try {
        const url = new URL(raw)
        if (url.protocol !== "http:" && url.protocol !== "https:") return null
        url.protocol = "https:"
        url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase()
        url.hash = ""
        const drop: string[] = []
        url.searchParams.forEach((_value, key) => {
            if (/^(utm_|ref$|referrer$|fbclid$|gclid$|spm$|from$)/i.test(key)) drop.push(key)
        })
        for (const key of drop) url.searchParams.delete(key)
        url.pathname = url.pathname.replace(/\/+$/, "") || "/"
        return url.toString()
    } catch {
        return null
    }
}

function normalizeTitle(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, " ")
}
