import { selectCitedEvidenceSources } from "@/features/agent-runs/selectors"
import type { AgentRunViewModel, EvidenceViewModel } from "@/features/agent-runs/types"

/**
 * 历史 Run 可能只恢复出部分 Evidence；消息内的安全引用覆盖更多实际引用时，
 * 应使用完整 metadata 来源，不能让一条残余 Evidence 遮蔽其余来源卡。
 */
export function selectCitationRun(
    run: AgentRunViewModel | null,
    persistedEvidence: EvidenceViewModel[],
): AgentRunViewModel | null {
    if (!run || persistedEvidence.length === 0) return run
    const persistedRun = { ...run, evidence: persistedEvidence }
    return selectCitedEvidenceSources(persistedRun).length > selectCitedEvidenceSources(run).length
        ? persistedRun
        : run
}
