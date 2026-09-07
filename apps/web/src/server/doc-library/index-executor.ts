import { buildDocumentPassages, hashDocumentText } from "./passage-builder"
import { indexEmbeddingProfileSchema, parseStoredIndexManifest } from "./index-contract"
import type { IndexJob } from "./index-job-policy"
import { z } from "zod"

export type IndexExecutionDeps = {
    heartbeat(): Promise<boolean>
    load(signal: AbortSignal): Promise<{ source: string; title: string; sourceFormat: "raw_markdown" | "extracted_text_v1"; manifestJson: string; manifestHash: string }>
    provider(): Promise<{
        profile: z.infer<typeof indexEmbeddingProfileSchema>
        quote(values: string[]): { inputTokens: number; costMicrousd: number }
        embed(values: string[], signal: AbortSignal): Promise<number[][]>
    }>
    reserve(value: { inputTokens: number; costMicrousd: number }): Promise<unknown>
    complete(value: { source: string; embeddings: number[][]; profile: unknown }): Promise<unknown>
    fail(code: "source_changed" | "validation_failed" | "model_outcome_unknown"): Promise<unknown>
    cancelled(): Promise<unknown>
}

/** 执行器不自动激活current；所有真实I/O由生产adapter提供，测试使用假provider。 */
export async function runDocumentIndexJob(job: Pick<IndexJob, "sourceHash" | "documentId">, deps: IndexExecutionDeps, signal?: AbortSignal) {
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    let heartbeatRunning: Promise<void> | null = null
    let calledModel = false, sourceChanged = false, lostLease = false
    const heartbeat = async () => {
        try { if (!await deps.heartbeat()) { lostLease = true; stop() } }
        catch { lostLease = true; stop() }
    }
    const timer = setInterval(() => {
        if (!heartbeatRunning) heartbeatRunning = heartbeat().finally(() => { heartbeatRunning = null })
    }, 20_000)
    const deadline = setTimeout(stop, 15 * 60_000)
    try {
        controller.signal.throwIfAborted()
        await heartbeat()
        controller.signal.throwIfAborted()
        const provider = await deps.provider()
        const loaded = await deps.load(controller.signal)
        if (hashDocumentText(loaded.source) !== job.sourceHash) { sourceChanged = true; throw new Error("source_changed") }
        const manifest = parseStoredIndexManifest(loaded.manifestJson, loaded.manifestHash)
        const snapshot = manifest.documents.find((doc) => doc.documentId === job.documentId)
        if (!snapshot || (snapshot.sourceFormat ?? "raw_markdown") !== loaded.sourceFormat) throw new Error("source_format_changed")
        if (JSON.stringify(provider.profile) !== JSON.stringify(manifest.profile)) throw new Error("profile_changed")
        const passages = buildDocumentPassages(loaded.source, loaded.title)
        const values = passages.map((passage) => `${loaded.title}\n${passage.locator}\n${passage.text}`)
        const reservation = provider.quote(values)
        controller.signal.throwIfAborted()
        await deps.reserve(reservation)
        controller.signal.throwIfAborted()
        calledModel = true
        const embeddings = await provider.embed(values, controller.signal)
        controller.signal.throwIfAborted()
        await deps.complete({ source: loaded.source, embeddings, profile: provider.profile })
        return "succeeded" as const
    } catch {
        const acknowledged = await deps.cancelled()
        if (acknowledged) return "cancelled" as const
        if (signal?.aborted || lostLease) {
            return "lease_lost" as const
        }
        await deps.fail(sourceChanged ? "source_changed" : calledModel ? "model_outcome_unknown" : "validation_failed")
        return "failed" as const
    } finally {
        clearInterval(timer); clearTimeout(deadline)
        signal?.removeEventListener("abort", stop)
        if (heartbeatRunning) await heartbeatRunning
    }
}
