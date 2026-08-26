export const TWO_FACTOR_STATUS_CHANGED_EVENT = "petrichor:two-factor-status-changed"

export function notifyTwoFactorStatusChanged() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(TWO_FACTOR_STATUS_CHANGED_EVENT))
}
