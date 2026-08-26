"use client"

import * as React from "react"
import { ShieldAlert } from "@/components/iconimate"
import { Link, useLocation } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { authApi } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { TWO_FACTOR_STATUS_CHANGED_EVENT } from "@/lib/two-factor-status"

export function TwoFactorEnforcementBanner() {
  const location = useLocation()
  const [show, setShow] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let requestId = 0

    const refresh = () => {
      const currentRequestId = ++requestId
      void authApi.profile()
        .then((res) => {
          if (cancelled || currentRequestId !== requestId) return
          const profile = res.data
          const needsSetup =
            profile.userType === "LOCAL" &&
            profile.systemRole === "SUPER_ADMIN" &&
            !profile.twoFactorEnabled
          setShow(needsSetup)
        })
        .catch(() => {
          if (!cancelled && currentRequestId === requestId) setShow(false)
        })
    }

    refresh()
    window.addEventListener(TWO_FACTOR_STATUS_CHANGED_EVENT, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(TWO_FACTOR_STATUS_CHANGED_EVENT, refresh)
    }
  }, [])

  if (!show) return null
  if (location.pathname === dashboardRoutes.account) return null

  return (
    <div className="px-4 pt-4 lg:px-6">
      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>建议启用二步验证</AlertTitle>
        <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>
            你是超级管理员，账号尚未启用 TOTP 二步验证，建议立即配置以加固账号安全。
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to={dashboardRoutes.account}>去启用</Link>
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
