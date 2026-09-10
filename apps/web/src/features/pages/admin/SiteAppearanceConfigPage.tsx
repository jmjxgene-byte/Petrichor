"use client"

import * as React from "react"
import { Loader2, RefreshCw, Save } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { readSiteBranding, type SiteBranding } from "@/lib/site-branding"
import { updatePublicBranding } from "@/lib/use-site-branding"
import {
    adminSiteAppearanceApi,
    type SiteAppearanceResponse,
} from "@/lib/api"
import { DEFAULT_RETYPESET_APPEARANCE } from "@/lib/retypeset-themes"

function resolveApiError(error: unknown, fallback: string) {
    return (
        (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
        (error instanceof Error ? error.message : "") ||
        fallback
    )
}

export function SiteAppearanceConfigPage() {
    const [config, setConfig] = React.useState<SiteAppearanceResponse>(() => ({
        ...DEFAULT_RETYPESET_APPEARANCE,
        createdAt: null,
        updatedAt: null,
    }))
    const [loading, setLoading] = React.useState(true)
    const [saving, setSaving] = React.useState(false)

    const fetchConfig = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await adminSiteAppearanceApi.detail()
            setConfig(res.data)
        } catch (e) {
            toast.error(resolveApiError(e, "加载前台配置失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void fetchConfig()
    }, [fetchConfig])

    const handleSave = React.useCallback(async () => {
        setSaving(true)
        try {
            const res = await adminSiteAppearanceApi.update({
                publicQaEnabled: config.publicQaEnabled,
                branding: config.branding ?? readSiteBranding(null),
            })
            setConfig(res.data)
            updatePublicBranding(res.data.branding)
            toast.success("前台配置已保存")
        } catch (e) {
            toast.error(resolveApiError(e, "保存前台配置失败"))
        } finally {
            setSaving(false)
        }
    }, [config])
    const branding = config.branding ?? readSiteBranding(null)
    const setBranding = <K extends keyof SiteBranding,>(key: K, value: SiteBranding[K]) =>
        setConfig(previous => ({ ...previous, branding: { ...(previous.branding ?? readSiteBranding(null)), [key]: value } }))

    return (
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">外观设置</h1>
                    <p className="text-sm text-muted-foreground">
                        配置前台公开页面的可用功能。
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={fetchConfig} disabled={loading || saving}>
                        {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        <span className="ml-2">刷新</span>
                    </Button>
                    <Button size="sm" onClick={handleSave} disabled={saving || loading}>
                        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        <span className="ml-2">保存</span>
                    </Button>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>站点品牌</CardTitle>
                    <CardDescription>所有字段都会公开展示，请勿填写密钥。留空可隐藏。简介和技能仍在「关于我」编辑；软件许可证声明保留。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2">
                    {([
                        ["title", "站点标题"], ["subtitle", "站点副标题"], ["copyrightOwner", "版权/站点名称"],
                        ["maintainer", "站点维护者（不是原软件作者）"], ["contactLabel", "联系链接文字"],
                        ["contactHref", "联系地址（HTTPS 或 mailto）"], ["repositoryUrl", "本站源码仓库（HTTPS）"],
                        ["avatarUrl", "关于页头像（站内路径或 HTTPS）"],
                    ] as const).map(([key, label]) => <div key={key} className="space-y-2">
                        <Label htmlFor={`branding-${key}`}>{label}</Label>
                        <Input id={`branding-${key}`} value={branding[key]} disabled={loading || saving}
                            maxLength={key.endsWith("Url") || key === "contactHref" ? 500 : 200}
                            onChange={event => setBranding(key, event.target.value)} />
                    </div>)}
                    <div className="space-y-2">
                        <Label htmlFor="branding-start-year">版权起始年（可空）</Label>
                        <Input id="branding-start-year" type="number" min={1900} max={2100} value={branding.startYear ?? ""}
                            disabled={loading || saving} onChange={event => setBranding("startYear", event.target.value ? Number(event.target.value) : null)} />
                    </div>
                    {([
                        ["showContact", "显示公开联系方式"], ["showMaintainer", "显示站点维护署名"],
                        ["showProjectPage", "显示项目宣传页及入口"], ["showProjectActions", "显示项目源码按钮"],
                    ] as const).map(([key, label]) => <div key={key} className="flex items-center justify-between gap-3 rounded-md border p-3">
                        <Label htmlFor={`branding-${key}`}>{label}</Label>
                        <Switch id={`branding-${key}`} checked={branding[key]} disabled={loading || saving} onCheckedChange={value => setBranding(key, value)} />
                    </div>)}
                    <p className="text-xs text-muted-foreground md:col-span-2">旧作者个人署名和一键部署推广按钮不再默认展示。头像地址请使用稳定的公开资源地址，不要填写临时预签名 URL。</p>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">前台问答</CardTitle>
                    <CardDescription>
                        开启后，未登录访客可在前台「问答」页面（/ask）就你公开分享的文章进行 AI 问答；每个访客每小时限 10 次提问。
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between rounded-md border p-3">
                        <div className="space-y-0.5">
                            <Label className="text-sm font-medium">开启前台公开问答</Label>
                            <p className="text-xs text-muted-foreground">关闭后 /ask 页面将提示功能已停用</p>
                        </div>
                        <Switch
                            checked={config.publicQaEnabled}
                            onCheckedChange={(value) =>
                                setConfig((prev) => ({ ...prev, publicQaEnabled: value }))
                            }
                        />
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
