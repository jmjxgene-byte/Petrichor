import { evaluateGroundedQa } from "../src/server/retrieval/grounded-evaluation"

try {
    const path = process.argv[2]
    if (!path || process.argv.length !== 3) throw new Error("invalid_arguments")
    const file = Bun.file(path)
    if (file.size > 2 * 1024 * 1024) throw new Error("input_too_large")
    const report = evaluateGroundedQa(await file.json())
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.passed ? 0 : 1
} catch {
    // 不输出文件内容、路径、Zod输入或业务查询。
    console.error(JSON.stringify({ passed: false, reason: "invalid_evaluation_input" }))
    process.exitCode = 2
}
