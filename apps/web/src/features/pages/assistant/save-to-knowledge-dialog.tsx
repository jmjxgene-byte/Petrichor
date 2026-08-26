"use client"

import * as React from "react"
import { BookOpen, Loader2 } from "@/components/iconimate"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  knowledgeBaseArticleApi,
  knowledgeBaseNodeApi,
  knowledgeBaseQaApi,
  type KnowledgeBaseQaSummary,
  type KnowledgeBaseTreeNode,
} from "@/lib/api"
import { knowledgeBaseArticlePath } from "@/lib/dashboard-routes"
import type { AgentRunViewModel } from "@/features/agent-runs/types"

export function SaveToKnowledgeButton({ run }: { run: AgentRunViewModel }) {
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseQaSummary[]>([])
  const [folders, setFolders] = React.useState<Array<{ id: string; label: string }>>([])
  const [knowledgeBaseId, setKnowledgeBaseId] = React.useState("")
  const [parentId, setParentId] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [contentMd, setContentMd] = React.useState("")

  const geneOpsEvidence = run.evidence.filter((item) => item.source === "geneops")
  const canSave = run.status === "completed" && Boolean(run.answer.trim()) && geneOpsEvidence.length > 0

  const openDialog = async () => {
    const nextTitle = run.goal.trim().replace(/\s+/g, " ").slice(0, 80) || "GeneOps 研究笔记"
    setTitle(nextTitle)
    setContentMd(buildKnowledgeDraft(run, geneOpsEvidence))
    setParentId("")
    setOpen(true)
    setLoading(true)
    try {
      const response = await knowledgeBaseQaApi.knowledgeBaseList()
      setKnowledgeBases(response.data.knowledgeBases)
      const first = response.data.knowledgeBases[0]?.id ?? ""
      setKnowledgeBaseId(first)
      if (first) await loadFolders(first)
    } catch {
      toast.error("加载知识库失败")
    } finally {
      setLoading(false)
    }
  }

  const loadFolders = async (kbId: string) => {
    if (!kbId) {
      setFolders([])
      return
    }
    try {
      const response = await knowledgeBaseNodeApi.tree(kbId, { pageNum: 1, pageSize: 200 })
      setFolders(flattenFolders(response.data.roots))
    } catch {
      setFolders([])
      toast.error("加载知识库文件夹失败")
    }
  }

  const save = async () => {
    if (!knowledgeBaseId || !title.trim() || !contentMd.trim()) {
      toast.error("请选择知识库并填写标题和正文")
      return
    }
    setSaving(true)
    try {
      const response = await knowledgeBaseArticleApi.create({
        knowledgeBaseId,
        parentId: parentId || null,
        title: title.trim(),
        contentMd: contentMd.trim(),
        tags: ["GeneOps"],
      })
      setOpen(false)
      toast.success("已沉淀为知识库文章")
      navigate(knowledgeBaseArticlePath(knowledgeBaseId, response.data.articleId))
    } catch {
      toast.error("沉淀到知识库失败")
    } finally {
      setSaving(false)
    }
  }

  if (!canSave) return null

  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px]" onClick={() => void openDialog()}>
        <BookOpen className="size-3.5" />
        沉淀到知识库
      </Button>
      <ModalShell
        open={open}
        onOpenChange={(next) => { if (!saving) setOpen(next) }}
        disableClose={saving}
        title="沉淀到知识库"
        description="确认后会把当前回答和来源链接复制到 Petrichor；不会复制 GeneOps 原始 chunks，也不会建立后台同步。"
        contentClassName="max-w-3xl"
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
            <Button disabled={saving || loading || !knowledgeBaseId} onClick={() => void save()}>
              {saving ? <><Loader2 className="size-4 animate-spin" />保存中...</> : "确认沉淀"}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="capture-kb">目标知识库</Label>
              <select
                id="capture-kb"
                value={knowledgeBaseId}
                disabled={loading || saving}
                onChange={(event) => {
                  const next = event.target.value
                  setKnowledgeBaseId(next)
                  setParentId("")
                  void loadFolders(next)
                }}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">请选择</option>
                {knowledgeBases.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="capture-folder">目标文件夹</Label>
              <select
                id="capture-folder"
                value={parentId}
                disabled={loading || saving || !knowledgeBaseId}
                onChange={(event) => setParentId(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">根目录</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="capture-title">标题</Label>
            <Input id="capture-title" value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="capture-content">Markdown 草稿</Label>
            <textarea
              id="capture-content"
              value={contentMd}
              disabled={saving}
              onChange={(event) => setContentMd(event.target.value)}
              className="min-h-80 w-full resize-y rounded-md border bg-background p-3 font-mono text-sm leading-6"
            />
          </div>
        </div>
      </ModalShell>
    </>
  )
}

export function buildKnowledgeDraft(
  run: AgentRunViewModel,
  evidence: AgentRunViewModel["evidence"],
) {
  const sources = evidence.map((item) => {
    const queriedAt = item.queriedAt ? ` · 查询于 ${new Date(item.queriedAt).toLocaleString("zh-CN")}` : ""
    const title = item.title.replace(/\s+/g, " ").replace(/[\\[\]]/g, "\\$&")
    const url = safeHttpUrl(item.url)
    return url
      ? `- [${title}](<${url}>)${queriedAt}`
      : `- ${title}${queriedAt}`
  })
  return [
    "> 本文由 Petrichor 助手基于 GeneOps 实时只读查询生成；保存前请核验关键结论。",
    "",
    "## 结论",
    "",
    run.answer.trim(),
    "",
    "## 来源",
    "",
    ...sources,
  ].join("\n")
}

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null
  } catch {
    return null
  }
}

function flattenFolders(nodes: KnowledgeBaseTreeNode[], depth = 0): Array<{ id: string; label: string }> {
  const result: Array<{ id: string; label: string }> = []
  for (const node of nodes) {
    if (node.type !== "FOLDER") continue
    result.push({ id: node.id, label: `${"— ".repeat(depth)}${node.name}` })
    if (node.children?.length) result.push(...flattenFolders(node.children, depth + 1))
  }
  return result
}
