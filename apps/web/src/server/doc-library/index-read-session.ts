/** 单次回答内共享版本选择，不保存正文或跨请求可写状态。 */
export type DocumentIndexReadSession = { pins: Map<number, number | null>; legacyVersions: Map<string, string>; queue: Promise<void> }

export function createDocumentIndexReadSession(): DocumentIndexReadSession {
    return { pins: new Map(), legacyVersions: new Map(), queue: Promise.resolve() }
}
