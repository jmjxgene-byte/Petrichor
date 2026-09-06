/** 逐个处理完整选择列表；失败项不计成功，也不阻止后续文件。 */
export async function runDocumentUploadQueue(
    files: File[], upload: (file: File) => Promise<void>,
    onFailure: (file: File, error: unknown) => void,
) {
    let success = 0
    let failed = 0
    for (const file of files) {
        try {
            await upload(file)
            success += 1
        } catch (error) {
            failed += 1
            onFailure(file, error)
        }
    }
    return { success, failed }
}
