import fs from "node:fs"
import path from "node:path"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { buildDocumentPassages } from "../src/server/doc-library/passage-builder"
const plan = planGroundedCanary(), vector = [1, ...Array(1023).fill(0)]
const artifact = { passed: true, calls: 22, syntheticMock: true, planHash: plan.planHash,
    documents: plan.documents.map(p => {
        const doc = syntheticQaDataset.documents.find(d => d.id === p.id)!
        return { ...doc, passages: buildDocumentPassages(doc.text, doc.title).map(p => ({ ...p, vector })) }
    }), cases: syntheticQaDataset.cases.filter(c => plan.caseIds.includes(c.id)).map(c => ({ ...c, query: [...c.history.map(h => h.content), c.question].join("\n"), vector })),
}
const dir = path.resolve(import.meta.dir, "../../../.data/canary-dry-run")
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(dir, "embed.json"), JSON.stringify(artifact), { flag: "wx", mode: 0o600 })
console.log(JSON.stringify({ dryRun: true, modelCalls: 0 }))
