import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { decodeCanaryFrame } from "./canary-transport"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { buildDocumentPassages } from "../src/server/doc-library/passage-builder"

const plan = planGroundedCanary()
const expected = "61faa403c88032f3633e7b9a354101e8bdfe85a312c04dc8bca6d2f1a3f1f89d"
const root = path.resolve(import.meta.dir, "../../..")
const directory = path.join(root, ".data/canary-61faa403")
const phase = process.argv[2]
if (plan.planHash !== expected || !["embed", "rerank"].includes(phase) || !["--execute-approved", "--preflight"].includes(process.argv[3])) throw new Error("canary_gate")
const documents = plan.documents.map(p => {
    const doc = syntheticQaDataset.documents.find(d => d.id === p.id)!
    return { ...doc, passages: buildDocumentPassages(doc.text, doc.title).map(passage => ({ ...passage,
        input: `${doc.title}\n${passage.locator}\n${passage.text}` })) }
})
const cases = syntheticQaDataset.cases.filter(c => plan.caseIds.includes(c.id)).map(c => ({
    ...c, query: [...c.history.map(h => h.content), c.question].join("\n"),
}))
const input = phase === "embed" ? { planHash: expected, documents, cases } : JSON.parse(fs.readFileSync(path.join(directory, "candidates.json"), "utf8"))
if (input.planHash !== expected) throw new Error("artifact_plan_gate")
if (phase === "rerank") {
    if (input.syntheticMock || input.cases.length !== 8 || new Set(input.cases.map((c: { id: string }) => c.id)).size !== 8) throw new Error("candidate_gate")
    for (const row of input.cases) {
        const c = cases.find(c => c.id === row.id)
        if (!c || c.query !== row.query || row.candidates.length > 20) throw new Error("candidate_scope_gate")
        for (const candidate of row.candidates) {
            const match = documents.flatMap(d => d.passages.map((p, i) => ({ id: `${d.id}:${i}`, documentId: d.id, text: p.text }))).find(p => p.id === candidate.id)
            if (!match || !c.scope.includes(match.documentId) || match.text !== candidate.text) throw new Error("candidate_content_gate")
        }
    }
}
const sshTarget = process.env.QA_SSH_TARGET, sshIdentity = process.env.QA_SSH_IDENTITY, sshPort = process.env.QA_SSH_PORT
const remote = `import postgres from "postgres";
import {createHash} from "node:crypto";
import {decodeApiKey} from "/app/apps/web/src/server/ai/config-logic.ts";
const input=${JSON.stringify(input)},phase=${JSON.stringify(phase)};
const report={planHash:input.planHash,phase,passed:false,calls:0,requests:[],documents:[],cases:[]};
let key=""; const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:10,onnotice:()=>{}});
async function post(route,body){
 const max=phase==="embed"?22:8;if(report.calls>=max)throw Error("call_limit");report.calls++;
 const start=Date.now();const r=await fetch("https://api.siliconflow.cn/v1/"+route,{method:"POST",redirect:"error",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!r.ok){await r.body?.cancel();throw Error("http_"+r.status)}
 const reader=r.body.getReader();let bytes=0;const parts=[];try{for(;;){const x=await reader.read();if(x.done)break;bytes+=x.value.length;if(bytes>262144)throw Error("response_limit");parts.push(x.value)}}finally{await reader.cancel()}
 const data=JSON.parse(Buffer.concat(parts).toString());report.requests.push({route,ms:Date.now()-start,tokens:Number.isSafeInteger(data.usage?.total_tokens)?data.usage.total_tokens:null});return data;
}
async function embed(values){const data=await post("embeddings",{model:"BAAI/bge-m3",input:values,encoding_format:"float"});const rows=data.data;
 if(!Array.isArray(rows)||rows.length!==values.length||new Set(rows.map(x=>x.index)).size!==values.length||rows.some(x=>!Number.isInteger(x.index)||x.index<0||x.index>=values.length||!Array.isArray(x.embedding)||x.embedding.length!==1024||x.embedding.some(n=>!Number.isFinite(n))||!x.embedding.some(n=>n!==0)))throw Error("vector_contract");return rows.sort((a,b)=>a.index-b.index).map(x=>x.embedding.map(Math.fround));}
try{
 const cipher=await db.begin("read only isolation level repeatable read",async tx=>{
 await tx\`select set_config('statement_timeout','8000',true),set_config('lock_timeout','1000',true)\`;
 const [gate]=await tx\`select current_user as role,current_setting('transaction_read_only') as ro\`;if(gate.role!=="petrichor_runtime"||gate.ro!=="on")throw Error("role_gate");
 const owners=await tx\`select id from petrichor_user where system_role='SUPER_ADMIN' limit 2\`;if(owners.length!==1)throw Error("owner_gate");
 const rows=await tx\`select m.model_id,m.dimensions,m.enabled as me,p.enabled as pe,p.provider_key,p.base_url,p.headers_json,c.api_key_enc from petrichor_ai_binding b join petrichor_ai_model m on m.id=b.model_ref_id and m.user_id=b.user_id join petrichor_ai_provider p on p.id=m.provider_id and p.user_id=b.user_id join petrichor_ai_credential c on c.id=p.credential_id and c.user_id=b.user_id where b.user_id=\${owners[0].id} and b.purpose='EMBEDDING' limit 2\`;
 const r=rows[0];if(rows.length!==1||r.model_id!=="BAAI/bge-m3"||r.dimensions!==1024||!r.me||!r.pe||r.provider_key!=="siliconflow"||(r.base_url&&r.base_url.replace(/\\/$/,"")!=="https://api.siliconflow.cn/v1")||Object.keys(JSON.parse(r.headers_json||"{}")).length)throw Error("binding_gate");return r.api_key_enc;});
 await db.end();key=decodeApiKey(cipher);if(!key)throw Error("credential_gate");
 if(phase==="embed"){
  if(input.documents.length!==3||input.documents.reduce((n,d)=>n+d.passages.length,0)!==48||input.cases.length!==8)throw Error("input_gate");
  for(const doc of input.documents){const vectors=[];for(let i=0;i<doc.passages.length;i+=4)vectors.push(...await embed(doc.passages.slice(i,i+4).map(p=>p.input)));report.documents.push({...doc,passages:doc.passages.map((p,i)=>({...p,vector:vectors[i]}))})}
  if(report.calls!==14)throw Error("document_call_gate");
  for(const c of input.cases)report.cases.push({...c,vector:(await embed([c.query]))[0]});
 }else{
  if(input.cases.length!==8)throw Error("input_gate");
  for(const c of input.cases){if(!c.candidates.length){report.cases.push({...c,rankedIds:[]});continue}if(c.candidates.length>20)throw Error("candidate_gate");
   const d=await post("rerank",{model:"BAAI/bge-reranker-v2-m3",query:c.query,documents:c.candidates.map(x=>x.text),top_n:c.candidates.length,return_documents:false});const rows=d.results;
   if(!Array.isArray(rows)||rows.length!==c.candidates.length||new Set(rows.map(x=>x.index)).size!==rows.length||rows.some(x=>!Number.isInteger(x.index)||x.index<0||x.index>=c.candidates.length||!Number.isFinite(x.relevance_score)))throw Error("rerank_contract");
   report.cases.push({id:c.id,rankedIds:rows.map(x=>c.candidates[x.index].id),scores:rows.map(x=>x.relevance_score)});
  }
 }
 report.passed=true;
}catch(e){const m=e instanceof Error?e.message:"unknown";report.error=/^[a-z_]+(?:[0-9]+)?$/.test(m)?m:"provider_or_metadata_failed";process.exitCode=1}
finally{key="";await db.end({timeout:2}).catch(()=>{});const payload=JSON.stringify(report);const hash=createHash("sha256").update(payload).digest("hex");await Bun.write(Bun.stdout,"PETRICHOR_CANARY_V1 "+Buffer.byteLength(payload)+" "+hash+"\\n"+payload+"\\nEND "+hash+"\\n")}`
new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(remote)
if (process.argv[3] === "--preflight") { console.log(JSON.stringify({ preflight: true, phase, planHash: expected, documentRequests: 14, queryRequests: 8, rerankLimit: 8, modelCalls: 0 })); process.exit(0) }
if (!sshTarget || !sshIdentity || !sshPort || !/^\d+$/.test(sshPort)) throw new Error("ssh_configuration_missing")
fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
// 标记一经创建即消耗本阶段执行权；任何失败不自动删除标记或重跑。
fs.writeFileSync(path.join(directory, `${phase}.started`), new Date().toISOString(), { flag: "wx", mode: 0o600 })
const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", sshPort, "-i", sshIdentity, sshTarget,
    "docker exec -i -w /app/apps/web petrichor-web-1 bun run -"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
child.stdin.write(remote); await child.stdin.end()
const timer = setTimeout(() => child.kill(), 600000)
try {
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    fs.writeFileSync(path.join(directory, `${phase}.transport.json`), JSON.stringify({ exitCode: code, stdoutBytes: Buffer.byteLength(output), stderrBytes: Buffer.byteLength(stderr),
        stdoutSha: createHash("sha256").update(output).digest("hex"), stderrSha: createHash("sha256").update(stderr).digest("hex") }), { flag: "wx", mode: 0o600 })
    if (Buffer.byteLength(output) > 4 * 1024 * 1024 + 256) throw new Error("artifact_limit")
    // 先保留受限回传，再解析；截断也必须留有证据，不能因解析异常丢失全部终态。
    fs.writeFileSync(path.join(directory, `${phase}.received.frame`), output, { flag: "wx", mode: 0o600 })
    const report = JSON.parse(decodeCanaryFrame(output))
    if (report.planHash !== expected || report.phase !== phase || !Number.isInteger(report.calls) || report.calls < 0 || report.calls > (phase === "embed" ? 22 : 8)) throw new Error("terminal_gate")
    fs.writeFileSync(path.join(directory, `${phase}.json`), JSON.stringify(report), { flag: "wx", mode: 0o600 })
    console.log(JSON.stringify({ phase, passed: report.passed, calls: report.calls, error: report.error ?? null, requests: report.requests }))
    if (code !== 0 || !report.passed) process.exitCode = 1
} catch {
    fs.writeFileSync(path.join(directory, `${phase}.transport-failure.json`), JSON.stringify({ phase, status: "uncertain", reason: "transport_or_artifact_failure", retryAllowed: false }), { flag: "wx", mode: 0o600 })
    console.error(JSON.stringify({ phase, passed: false, status: "uncertain", retryAllowed: false }))
    process.exitCode = 1
} finally { clearTimeout(timer) }
