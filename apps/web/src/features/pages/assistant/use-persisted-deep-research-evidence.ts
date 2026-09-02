import { useMemo } from "react"
import { useAuiState } from "@assistant-ui/react"

import { persistedDeepResearchEvidence } from "./assistant-message-utils"

/**
 * Assistant UI 的 selector 必须返回引用稳定的快照值，否则 React 会把每次新数组
 * 视为外部 Store 持续更新。这里只订阅原始 metadata，再在组件内做有依赖的派生。
 */
export function usePersistedDeepResearchEvidence() {
    const metadata = useAuiState((state) => state.message.metadata)
    return useMemo(() => persistedDeepResearchEvidence(metadata), [metadata])
}
