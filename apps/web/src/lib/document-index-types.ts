export type DocumentIndexPhase = "disabled" | "not_built" | "building" | "ready_to_activate" | "ready" | "stale" | "failed" | "cancelled" | "unavailable"
export interface DocumentIndexGenerationView {
  id: string
  status: string
  expectedDocuments: number
  completedDocuments: number
  passageCount: number
  manifestHash: string
  errorCode: string | null
  updatedAt: string
}
export interface DocumentIndexStatus {
  libraryId: string
  enabled: boolean
  workerConfigured: boolean
  hybridConfigured: boolean
  keywordDocuments: number
  phase: DocumentIndexPhase
  currentReady: boolean
  current: DocumentIndexGenerationView | null
  latest: DocumentIndexGenerationView | null
}
