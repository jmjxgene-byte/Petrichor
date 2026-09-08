/** 全部为虚构演练资料，不是生产规则；期望项为工程初稿，尚未经人工独立验收。 */
export const topics = [
    ["仓储暂停", "暂时停止仓库出货", "核对未发运清单"], ["补货窗口", "避免到货与盘点撞期", "确认接收日期"],
    ["资料归档", "保存旧版操作记录", "登记版本号"], ["签收复核", "货到了但收货凭证不全", "补齐收货记录"],
    ["运费补贴", "核对物流费用减免", "核验费用项目"], ["异常编码", "区分失败原因", "记录错误码"],
    ["批次追溯", "追查一批货的流转", "核对批次编号"], ["售后退回", "收到客户退回的物品", "登记退回原因"],
    ["版本冻结", "避免发布中途混入新改动", "锁定版本摘要"], ["地址更正", "修正尚未出库的收货信息", "确认未出库状态"],
    ["库存盘点", "账面数量和货架实物不一致", "比对实物数量"], ["通知静默", "减少非紧急消息干扰", "保留紧急告警"],
    ["审核队列", "按顺序处理待审批记录", "检查前置材料"], ["权限委派", "让另一位成员处理指定工作", "限制授权范围"],
    ["账单核验", "核对费用明细与结算总额", "逐项对账"],
] as const

export type SyntheticQaCase = { id: string; group: "terms" | "late_passage" | "synthesis" | "followup" | "no_answer" | "temporal";
    semantic: boolean; question: string; history: Array<{ role: "user" | "assistant"; content: string }>; scope: string[];
    expectedResolution: "answer" | "clarify" | "insufficient"; evidence: Array<{ documentId: string; quote: string }> }

const id = (index: number) => `synthetic-topic-${index + 1}`
const fact = (index: number) => `虚构演练系统的${topics[index][0]}用于${topics[index][1]}，执行前必须${topics[index][2]}；识别码为QA-${index + 1}。`
const ending = (index: number) => `${topics[index][0]}的文末补充：结案标签为DONE-${index + 1}，须由复核员确认，不能自行跳过复核。`
const reference = (index: number, late = false) => ({ documentId: id(index), quote: late ? ending(index) : fact(index) })

export const syntheticQaDocuments = topics.map(([title], index) => ({ id: id(index), title: `虚构${title}演练`, text:
    `# 虚构${title}演练\n\n${fact(index)}\n\n## 非结论性过程记录\n\n` +
    Array.from({ length: 1000 }, (_, row) => `第${row + 1}项是演练占位记录，只说明过程仍在进行，不构成操作结论。`).join("\n\n") +
    `\n\n## 文末结案记录\n\n${ending(index)}\n`,
})).concat([
    { id: "timeline-old", title: "虚构旧规则", text: "# 虚构旧规则\n\n来源发布时间：2025-01-01T00:00:00Z。演练并发上限为2。" },
    { id: "timeline-new", title: "虚构新规则", text: "# 虚构新规则\n\n来源发布时间：2026-01-01T00:00:00Z。演练并发上限为3。" },
    { id: "timeline-undated", title: "虚构无日期说法", text: "# 虚构无日期说法\n\n没有可验证的来源发布时间。有人声称演练并发上限为5，不能确定其适用版本。" },
    { id: "timeline-conflict", title: "虚构同日冲突", text: "# 虚构同日冲突\n\n来源发布时间：2026-01-01T00:00:00Z。另一份记录声称演练并发上限为7，未提供权威性证明。" },
])
const timelineRef = (documentId: string) => ({ documentId, quote: syntheticQaDocuments.find((doc) => doc.id === documentId)!.text.split("\n\n")[1] })

export const syntheticQaCases: SyntheticQaCase[] = [
    ...topics.map(([topic], index): SyntheticQaCase => ({ id: `terms-${index + 1}`, group: "terms", semantic: false,
        question: `QA-${index + 1}（${topic}）执行前要检查什么？`, history: [], scope: [id(index)], expectedResolution: "answer", evidence: [reference(index)] })),
    ...topics.map(([topic], index): SyntheticQaCase => ({ id: `late-${index + 1}`, group: "late_passage", semantic: false,
        question: `${topic}文末补充的结案标签和复核要求是什么？`, history: [], scope: [id(index)], expectedResolution: "answer", evidence: [reference(index, true)] })),
    ...topics.slice(0, 10).map(([, scenario], index): SyntheticQaCase => ({ id: `synthesis-${index + 1}`, group: "synthesis", semantic: true,
        question: `同时需要${scenario}和${topics[index + 5][1]}，两项操作各有哪些前置检查？`, history: [], scope: [id(index), id(index + 5)],
        expectedResolution: "answer", evidence: [reference(index), reference(index + 5)] })),
    ...topics.slice(0, 5).map(([topic], index): SyntheticQaCase => ({ id: `followup-${index + 1}`, group: "followup", semantic: true,
        question: "这个流程执行前还需要核对什么？", history: [{ role: "user", content: `我们正在讨论${topic}。` }], scope: [id(index)], expectedResolution: "answer", evidence: [reference(index)] })),
    ...["翻新怎么翻？", "这个能用吗？", "那些怎么处理？", "它是否适用？", "那个为什么不行？"].map((question, index): SyntheticQaCase => ({
        id: `followup-${index + 6}`, group: "followup", semantic: false, question, history: [], scope: [id(index)], expectedResolution: "clarify", evidence: [] })),
    ...["商业授权价格是多少？", "未记载地区的时区是什么？", "2027年会发布什么规则？", "海外服务器具体位置在哪里？", "系统实际用户总量是多少？"].map((question, index): SyntheticQaCase => ({
        id: `missing-${index + 1}`, group: "no_answer", semantic: false, question, history: [], scope: [id(index)], expectedResolution: "insufficient", evidence: [] })),
    { id: "time-1", group: "temporal", semantic: false, question: "在有明确日期的记录里，最新的并发上限是什么？", history: [], scope: ["timeline-old", "timeline-new"], expectedResolution: "answer", evidence: [timelineRef("timeline-new")] },
    { id: "time-2", group: "temporal", semantic: false, question: "2025到2026年的并发上限怎样变化？", history: [], scope: ["timeline-old", "timeline-new"], expectedResolution: "answer", evidence: [timelineRef("timeline-old"), timelineRef("timeline-new")] },
    { id: "time-3", group: "temporal", semantic: false, question: "能确定无日期记录的5就是最新上限吗？", history: [], scope: ["timeline-undated"], expectedResolution: "insufficient", evidence: [timelineRef("timeline-undated")] },
    { id: "time-4", group: "temporal", semantic: false, question: "同一天的3与7哪一个可以确定是正确规则？", history: [], scope: ["timeline-new", "timeline-conflict"], expectedResolution: "insufficient", evidence: [timelineRef("timeline-new"), timelineRef("timeline-conflict")] },
    { id: "time-5", group: "temporal", semantic: false, question: "上限为2和上限为3的两份记录先后顺序是什么？", history: [], scope: ["timeline-old", "timeline-new"], expectedResolution: "answer", evidence: [timelineRef("timeline-old"), timelineRef("timeline-new")] },
]

export const syntheticQaDataset = { version: "grounded-qa-synthetic-v1", provenance: "synthetic-engineering-draft-not-human-reviewed", documents: syntheticQaDocuments, cases: syntheticQaCases }
