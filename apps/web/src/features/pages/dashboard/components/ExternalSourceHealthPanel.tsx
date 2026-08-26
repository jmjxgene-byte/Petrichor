"use client"

import { Database } from "@/components/iconimate"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { DashboardOverviewResponse } from "@/lib/api"
import { formatDuration } from "../metrics-utils"

export function ExternalSourceHealthPanel({
  data,
  loading,
}: {
  data?: DashboardOverviewResponse["externalSources"]
  loading: boolean
}) {
  if (loading) return <div className="h-52 animate-pulse rounded-xl bg-muted" />
  const total = data?.totalQueries ?? 0
  const success = data?.successQueries ?? 0
  const successRate = total > 0 ? Math.round((success / total) * 1000) / 10 : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="size-4" />
              实时资料源
            </CardTitle>
            <CardDescription>最近 {data?.windowDays ?? 30} 天的个人查询情况</CardDescription>
          </div>
          <Badge variant={(data?.readySources ?? 0) > 0 ? "default" : "secondary"}>
            {data?.readySources ?? 0}/{data?.totalSources ?? 0} 可用
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="查询" value={String(total)} />
          <Metric label="成功率" value={`${successRate}%`} />
          <Metric label="失败" value={String(data?.errorQueries ?? 0)} />
          <Metric label="平均耗时" value={formatDuration(data?.avgDurationMs ?? 0)} />
        </div>
        <div className="flex flex-wrap gap-2">
          {(data?.tools ?? []).length > 0 ? data!.tools.map((tool) => (
            <span key={tool.name} className="rounded-md border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
              {friendlyToolName(tool.name)} · {tool.count} 次 · {formatDuration(tool.avgMs)}
            </span>
          )) : <span className="text-xs text-muted-foreground">暂无实时资料查询</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function friendlyToolName(value: string) {
  const names: Record<string, string> = {
    "geneops.search": "搜索",
    "geneops.read_chunks": "深读",
    "geneops.graph_search": "图谱搜索",
    "geneops.graph_expand": "图谱展开",
    "geneops.backlinks": "反向链接",
  }
  return names[value] ?? value
}
