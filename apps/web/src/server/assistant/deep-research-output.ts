import { createHash } from "node:crypto"

import type { AgentEvidence, AgentEvidenceSource } from "./agent-runtime/types"
import type { DeepResearchFinalMessage } from "./deep-research-job-store"
import type { DeepResearchEvidence } from "./deep-research-pipeline"

export function buildDeepResearchReferenceKey(input: {
    source: string
    title: string
    url: string | null
    fallbackKey: string
}) {
    const canonical = input.url ? canonicalHttpUrl(input.url) : null
    if (canonical) return `url:${canonical}`
    const fallback = input.fallbackKey.trim()
    if (fallback) return `source:${input.source}:${fallback}`
    return `title:${input.source}:${normalizeTitle(input.title)}`
}

export function normalizeDeepResearchUrl(raw: string | null) {
    return raw ? safeHttpUrl(raw) : null
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
    return evidence.map((item) => ({
        title: item.title.slice(0, 500),
        url: item.url,
        source: (item.sourceName?.trim() || item.source).slice(0, 100),
        sourceKind: normalizeAgentEvidenceSource(item.source),
        queriedAt: item.queriedAt,
    }))
}

export function toMetadataOnlyAgentEvidence(
    evidence: DeepResearchEvidence[],
    now = Date.now(),
): AgentEvidence[] {
    return evidence.map((item, index) => ({
        id: `deep_${createHash("sha256").update(item.referenceKey).digest("hex").slice(0, 24)}`,
        source: normalizeAgentEvidenceSource(item.source),
        title: item.title,
        content: "",
        ...(item.url ? { url: item.url } : {}),
        metadata: {
            sourceName: item.sourceName?.trim() || item.source,
            queriedAt: item.queriedAt,
            citationIndex: index + 1,
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

function safeHttpUrl(raw: string) {
    try {
        const url = new URL(raw)
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null
    } catch {
        return null
    }
}

function normalizeTitle(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, " ")
}
