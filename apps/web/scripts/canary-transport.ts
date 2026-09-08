import { createHash } from "node:crypto"
export const CANARY_FRAME_MAX_BYTES = 4 * 1024 * 1024
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** 仅用于受限canary产物，不输出原文或解析错误载荷。 */
export function encodeCanaryFrame(payload: string) {
    const size = Buffer.byteLength(payload)
    if (size > CANARY_FRAME_MAX_BYTES) throw new Error("frame_oversize")
    const hash = digest(payload)
    return `PETRICHOR_CANARY_V1 ${size} ${hash}\n${payload}\nEND ${hash}\n`
}

export function decodeCanaryFrame(frame: string) {
    if (Buffer.byteLength(frame) > CANARY_FRAME_MAX_BYTES + 256) throw new Error("frame_oversize")
    const first = frame.indexOf("\n")
    if (first < 0 || first > 150) throw new Error("frame_header")
    const header = /^PETRICHOR_CANARY_V1 (\d{1,8}) ([a-f0-9]{64})$/.exec(frame.slice(0, first))
    if (!header) throw new Error("frame_header")
    const size = Number(header[1]), hash = header[2], tail = `\nEND ${hash}\n`
    if (size > CANARY_FRAME_MAX_BYTES) throw new Error("frame_oversize")
    if (!frame.endsWith(tail)) throw new Error("frame_terminal_missing")
    const payload = frame.slice(first + 1, -tail.length)
    if (Buffer.byteLength(payload) !== size) throw new Error("frame_length_mismatch")
    if (digest(payload) !== hash) throw new Error("frame_hash_mismatch")
    return payload
}
