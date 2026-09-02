export function isLinuxDoUiEnabled(value: string | undefined) {
  return value === "true"
}

export const linuxDoUiEnabled = isLinuxDoUiEnabled(
  import.meta.env.PETRICHOR_PUBLIC_LINUXDO_ENABLED,
)

export function shouldShowLinuxDoAccount(linuxDoBound: boolean) {
  return linuxDoUiEnabled || linuxDoBound
}
