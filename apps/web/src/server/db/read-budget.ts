import { sql } from "drizzle-orm"
import { getDb, isSqliteDatabase } from "./client"

export type ReadBudget = { abortSignal?: AbortSignal; queryDeadlineAt?: number }
type Reader = Pick<ReturnType<typeof getDb>, "select">

/** 复用既有池；事务本地超时不污染下一次请求，不做有竞态的协议cancel。 */
export async function withReadBudget<T>(run: (reader: Reader, checkpoint: () => Promise<void>) => PromiseLike<T>, input: ReadBudget = {}): Promise<T> {
    const deadline = Math.min(input.queryDeadlineAt ?? Infinity, Date.now() + 8_000)
    const check = () => {
        input.abortSignal?.throwIfAborted()
        if (Date.now() >= deadline) throw new Error("资料查询已超时")
    }
    check()
    if (isSqliteDatabase()) {
        const result = await run(getDb(), async () => check())
        check()
        return result
    }
    return await getDb().transaction(async (tx) => {
        // 排队获取连接期间也可能已经取消，不能拿到连接后仍运行旧查询。
        check()
        const checkpoint = async () => {
            check()
            await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, deadline - Date.now()))}, true), set_config('lock_timeout', '1000', true)`)
            check()
        }
        await checkpoint()
        const result = await run(tx, checkpoint)
        check()
        return result
    }, { accessMode: "read only", isolationLevel: "repeatable read" })
}
