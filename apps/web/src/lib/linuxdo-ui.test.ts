import { describe, expect, it } from "vitest"

import { isLinuxDoUiEnabled, shouldShowLinuxDoAccount } from "./linuxdo-ui"

describe("LinuxDo UI visibility", () => {
  it("默认和非精确值都保持关闭", () => {
    expect(isLinuxDoUiEnabled(undefined)).toBe(false)
    expect(isLinuxDoUiEnabled("false")).toBe(false)
    expect(isLinuxDoUiEnabled("TRUE")).toBe(false)
  })

  it("只有显式 true 才启用入口", () => {
    expect(isLinuxDoUiEnabled("true")).toBe(true)
  })

  it("入口关闭时仍保留历史已绑定账号的信息", () => {
    expect(shouldShowLinuxDoAccount(false)).toBe(false)
    expect(shouldShowLinuxDoAccount(true)).toBe(true)
  })
})
