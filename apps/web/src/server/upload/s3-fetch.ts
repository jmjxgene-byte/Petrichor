import { getServerConfig } from "@/config/server"
import { HttpError } from "@/server/http/response"
import { getLocalStorageDirOrNull, readLocalObjectBytes } from "@/server/upload/local-storage"
import { createS3PresignedUrl, stripS4KeyPrefix } from "@/server/upload/s3-presign"

const EXT_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

function guessMimeFromKey(objectKey: string): string {
    const match = objectKey.toLowerCase().match(/\.[a-z0-9]+$/)
    return (match && EXT_MIME[match[0]]) || "image/png"
}

export interface S3ObjectBytes {
    data: Buffer
    mime: string
}

/**
 * 服务端按对象键下载 S3 文件，返回原始字节与 MIME。
 * 多模态识别与裁剪嵌入图共用这一份字节，避免重复下载。
 */
export async function fetchS3ObjectBytes(objectKey: string, options?: { maxBytes: number; timeoutMs: number; abortSignal?: AbortSignal }): Promise<S3ObjectBytes> {
    options?.abortSignal?.throwIfAborted()
    if (getLocalStorageDirOrNull()) {
        const result = await readLocalObjectBytes(objectKey, options?.maxBytes)
        options?.abortSignal?.throwIfAborted()
        return result
    }

    const config = getServerConfig().s3
    if (!config) {
        throw new HttpError(500, "S3 存储未配置")
    }
    const key = stripS4KeyPrefix(objectKey)
    const url = createS3PresignedUrl({
        ...config,
        expiresSeconds: config.downloadExpireSeconds,
        method: "GET",
        objectKey: key,
    })
    const response = await fetch(url, options ? { signal: options.abortSignal
        ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(options.timeoutMs)])
        : AbortSignal.timeout(options.timeoutMs), redirect: "error" } : undefined)
    if (!response.ok) {
        throw new HttpError(502, `下载页面图片失败：HTTP ${response.status}`)
    }
    let data: Buffer
    if (options) {
        data = await readBoundedObjectBody(response, options.maxBytes)
    } else {
        data = Buffer.from(await response.arrayBuffer())
    }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || guessMimeFromKey(key)
    return { data, mime }
}

export async function readBoundedObjectBody(response: Response, maxBytes: number): Promise<Buffer> {
    if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel()
        throw new HttpError(413, "文件超过允许大小")
    }
    if (!response.body) throw new HttpError(400, "文件内容为空")
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) throw new HttpError(413, "文件超过允许大小")
            parts.push(value)
        }
        return Buffer.concat(parts, size)
    } finally {
        try { await reader.cancel() } finally { reader.releaseLock() }
    }
}

/**
 * 服务端按对象键下载 S3 文件，并编码为 base64 data URL，
 * 供多模态模型 image_url 直接使用（避免依赖内网 S3 对模型可达性）。
 */
export async function fetchS3ObjectAsDataUrl(objectKey: string): Promise<string> {
    const { data, mime } = await fetchS3ObjectBytes(objectKey)
    return `data:${mime};base64,${data.toString("base64")}`
}

/** 把字节编码为多模态可直接消费的 data URL。 */
export function toImageDataUrl(image: S3ObjectBytes): string {
    return `data:${image.mime};base64,${image.data.toString("base64")}`
}
