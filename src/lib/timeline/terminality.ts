/** 一个 Agent 事件是否终止当前回合。 */
export function isTerminalAgentEvent(kind: string, _isResultError = false): boolean {
  return kind === 'done' || kind === 'error' || kind === 'result';
}

/** 终态帧是否应该结束当前运行；合成边界只关闭上一个回合。 */
export function shouldProcessTerminalEvent(
  isRunning: boolean,
  kind: string,
  isResultError = false,
  isSyntheticBoundary = false,
): boolean {
  if (!isTerminalAgentEvent(kind, isResultError)) {
    return true;
  }

  // A synthesized continuation-turn boundary closes the PREVIOUS turn — the
  // sidecar emits it right before the next prompt's content streams, so it
  // must never end the run the user just started.
  if (isSyntheticBoundary) {
    return false;
  }

  return isRunning;
}
