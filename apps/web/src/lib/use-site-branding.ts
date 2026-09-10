import { useEffect, useSyncExternalStore } from "react"
import { publicSiteAppearanceApi } from "./api"
import { DEFAULT_SITE_BRANDING, readSiteBranding } from "./site-branding"
let value = DEFAULT_SITE_BRANDING
let pending: Promise<void> | null = null
let loaded = false
let revision = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function updatePublicBranding(raw: unknown) {
    revision++; value = readSiteBranding(raw); loaded = true
    for (const listener of listeners) listener()
}
export function useSiteBranding() {
    const snapshot = useSyncExternalStore(subscribe, () => value, () => DEFAULT_SITE_BRANDING)
    useEffect(() => {
        if (loaded || pending) return
        const version = revision
        pending = publicSiteAppearanceApi.detail().then(response => {
            if (revision === version) updatePublicBranding(response.data.branding)
        }).catch(() => { /* 失败保留中性默认值，不泄漏原作者信息。 */ }).finally(() => { pending = null })
    }, [])
    return snapshot
}
