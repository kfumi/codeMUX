export interface MobileRunningStateInput {
  sending: boolean;
  desktopRunning: boolean;
}

export function resolveMobileRunningState({
  sending,
  desktopRunning,
}: MobileRunningStateInput): boolean {
  return sending || desktopRunning;
}
