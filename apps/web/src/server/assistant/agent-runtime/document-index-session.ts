import { createDocumentIndexReadSession, type DocumentIndexReadSession } from "@/server/doc-library/index-read-session"
import type { ToolExecutionContext } from "./types"

const sessions = new WeakMap<ToolExecutionContext["state"], DocumentIndexReadSession>()

/** 子代理继承父回答的会话；主Agent/Deep独立state自动取得独立会话。 */
export function getDocumentIndexSession(ctx: ToolExecutionContext): DocumentIndexReadSession {
    if (ctx.documentIndexReadSession) return ctx.documentIndexReadSession
    let session = sessions.get(ctx.state)
    if (!session) {
        session = createDocumentIndexReadSession()
        sessions.set(ctx.state, session)
    }
    return session
}
