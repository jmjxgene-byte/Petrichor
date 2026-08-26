"use client"

import * as React from "react"
import { Database, Loader2, Plus, RefreshCw } from "@/components/iconimate"
import { toast } from "sonner"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  authApi,
  externalSourceApi,
  type ExternalSourceResponse,
} from "@/lib/api"

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const data = (error as { response?: { data?: { msg?: unknown } } }).response?.data
    if (typeof data?.msg === "string" && data.msg) return data.msg
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export function ExternalSourcesPage() {
  const [items, setItems] = React.useState<ExternalSourceResponse[]>([])
  const [featureEnabled, setFeatureEnabled] = React.useState(false)
  const [isAdmin, setIsAdmin] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ExternalSourceResponse | null>(null)
  const [name, setName] = React.useState("GeneOps 生产知识")
  const [password, setPassword] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<ExternalSourceResponse | null>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [profile, sources] = await Promise.all([authApi.profile(), externalSourceApi.list()])
      setIsAdmin(profile.data.systemRole === "SUPER_ADMIN")
      setItems(sources.data.items)
      setFeatureEnabled(sources.data.featureEnabled)
    } catch (error) {
      toast.error(errorMessage(error, "外部数据源加载失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const openCreate = () => {
    setEditing(null)
    setName("GeneOps 生产知识")
    setPassword("")
    setEditorOpen(true)
  }

  const openEdit = (source: ExternalSourceResponse) => {
    setEditing(source)
    setName(source.name)
    setPassword("")
    setEditorOpen(true)
  }

  const save = async () => {
    if (!name.trim()) {
      toast.error("请输入数据源名称")
      return
    }
    if (!editing && password.length < 20) {
      toast.error("连接密码至少需要 20 个字符")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await externalSourceApi.update({
          id: editing.id,
          name: name.trim(),
          ...(password ? { password } : {}),
        })
      } else {
        await externalSourceApi.create({ name: name.trim(), password })
      }
      setPassword("")
      setEditorOpen(false)
      toast.success(editing ? "数据源已更新" : "数据源已创建，请先测试连接")
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error, "保存失败"))
    } finally {
      setSaving(false)
    }
  }

  const test = async (source: ExternalSourceResponse) => {
    setBusyId(source.id)
    try {
      await externalSourceApi.test(source.id)
      toast.success("连接、只读权限与 RPC contract 验证通过")
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error, "连接测试失败"))
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (source: ExternalSourceResponse, enabled: boolean) => {
    setBusyId(source.id)
    try {
      await externalSourceApi.update({ id: source.id, enabled })
      toast.success(enabled ? "GeneOps 数据源已启用" : "GeneOps 数据源已停用")
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error, "状态更新失败"))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    try {
      await externalSourceApi.delete(deleteTarget.id)
      toast.success("数据源已删除")
      setDeleteTarget(null)
      await refresh()
    } catch (error) {
      toast.error(errorMessage(error, "删除失败"))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">外部数据源</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            GeneOps 实时知识通过专用只读角色和 knowledge_vault RPC 提供，不复制生产业务数据。
          </p>
        </div>
        {isAdmin ? (
          <Button onClick={openCreate} disabled={items.length > 0}>
            <Plus className="size-4" />
            添加 GeneOps
          </Button>
        ) : null}
      </div>

      {!featureEnabled ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          生产功能开关尚未开启。可以先配置并测试连接，验收通过后再启用。
        </div>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>项目</TableHead>
              <TableHead>能力</TableHead>
              <TableHead>最近检查</TableHead>
              <TableHead>状态</TableHead>
              {isAdmin ? <TableHead className="text-right">操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={isAdmin ? 6 : 5} className="h-28 text-center"><Loader2 className="mx-auto size-5 animate-spin" /></TableCell></TableRow>
            ) : items.length === 0 ? (
              <TableRow><TableCell colSpan={isAdmin ? 6 : 5} className="h-28 text-center text-muted-foreground">尚未配置 GeneOps 数据源</TableCell></TableRow>
            ) : items.map((source) => (
              <TableRow key={source.id}>
                <TableCell className="font-medium"><span className="inline-flex items-center gap-2"><Database className="size-4" />{source.name}</span></TableCell>
                <TableCell className="font-mono text-xs">{source.projectRef}<div className="text-muted-foreground">{source.region}</div></TableCell>
                <TableCell className="text-sm">Exact / Fuzzy / Graph</TableCell>
                <TableCell className="text-sm">{source.lastCheckedAt ? new Date(source.lastCheckedAt).toLocaleString("zh-CN") : "未检查"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant={source.lastCheckStatus === "OK" ? "default" : "secondary"}>{source.lastCheckStatus ?? "未测试"}</Badge>
                    {isAdmin ? <Switch checked={source.enabled} disabled={busyId === source.id} onCheckedChange={(next) => void toggle(source, next)} /> : null}
                  </div>
                  {source.lastCheckMessage ? <div className="mt-1 max-w-xs text-xs text-muted-foreground">{source.lastCheckMessage}</div> : null}
                </TableCell>
                {isAdmin ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" disabled={busyId === source.id} onClick={() => void test(source)}><RefreshCw className="size-4" />测试</Button>
                      <Button size="sm" variant="outline" onClick={() => openEdit(source)}>编辑</Button>
                      <Button size="sm" variant="outline" disabled={source.enabled} onClick={() => setDeleteTarget(source)}>删除</Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ModalShell
        open={editorOpen}
        onOpenChange={(open) => { if (!saving) setEditorOpen(open) }}
        disableClose={saving}
        title={editing ? "编辑 GeneOps 数据源" : "添加 GeneOps 数据源"}
        description="连接信息只在服务端加密保存，不会返回浏览器或模型。"
        footer={<><Button variant="outline" disabled={saving} onClick={() => setEditorOpen(false)}>取消</Button><Button disabled={saving} onClick={() => void save()}>{saving ? "保存中..." : "保存"}</Button></>}
      >
        <div className="space-y-4">
          <div className="space-y-2"><Label>名称</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="space-y-2">
            <Label>连接</Label>
            <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs">
              aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres<br />
              petrichor_geneops_reader.snsvqlqwnpyzcftubeab
            </div>
          </div>
          <div className="space-y-2">
            <Label>{editing ? "新密码（留空表示不轮换）" : "数据库密码"}</Label>
            <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open && !busyId) setDeleteTarget(null) }}
        disableClose={busyId != null}
        title="确认删除数据源？"
        description="只删除 Petrichor 中的加密连接配置和审计记录，不修改 GeneOps 数据。"
        footer={<><Button variant="outline" disabled={busyId != null} onClick={() => setDeleteTarget(null)}>取消</Button><Button variant="destructive" disabled={busyId != null} onClick={() => void remove()}>确认删除</Button></>}
      />
    </div>
  )
}
