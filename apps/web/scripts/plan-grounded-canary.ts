import { createGroundedReviewTemplate, planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"

try {
    const args = process.argv.slice(2)
    if (args.some(arg => arg.startsWith("--") && arg !== "--review-template")) throw new Error("unsupported_mode")
    if (args.includes("--review-template") && args.length !== 1) throw new Error("invalid_arguments")
    console.log(JSON.stringify(args[0] === "--review-template" ? createGroundedReviewTemplate() : planGroundedCanary(args.length ? args : undefined), null, 2))
} catch {
    console.error(JSON.stringify({ mode: "plan_only", error: "invalid_canary_plan", authorizedToExecute: false }))
    process.exitCode = 2
}
