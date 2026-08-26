// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({
  profile: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  authApi: {
    profile: apiMocks.profile,
  },
}))

import { TwoFactorEnforcementBanner } from "./two-factor-enforcement-banner"
import { notifyTwoFactorStatusChanged } from "@/lib/two-factor-status"

const baseProfile = {
  userType: "LOCAL",
  systemRole: "SUPER_ADMIN",
  twoFactorEnabled: false,
}

function renderBanner() {
  return render(
    <MemoryRouter initialEntries={["/dashboard/knowledge"]}>
      <TwoFactorEnforcementBanner />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  apiMocks.profile.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("TwoFactorEnforcementBanner", () => {
  it("超级管理员尚未启用 TOTP 时显示提示", async () => {
    apiMocks.profile.mockResolvedValue({ data: baseProfile })

    renderBanner()

    expect(await screen.findByText("建议启用二步验证")).toBeTruthy()
  })

  it("TOTP 状态变更后重新读取 profile 并隐藏旧提示", async () => {
    apiMocks.profile
      .mockResolvedValueOnce({ data: baseProfile })
      .mockResolvedValueOnce({ data: { ...baseProfile, twoFactorEnabled: true } })

    renderBanner()
    expect(await screen.findByText("建议启用二步验证")).toBeTruthy()

    act(() => notifyTwoFactorStatusChanged())

    await waitFor(() => {
      expect(apiMocks.profile).toHaveBeenCalledTimes(2)
      expect(screen.queryByText("建议启用二步验证")).toBeNull()
    })
  })
})
