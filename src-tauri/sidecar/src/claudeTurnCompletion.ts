export function shouldEmitDoneOnClaudeIteratorCompletion({
  turnActive,
  sawResult,
  aborted,
}: {
  turnActive: boolean;
  sawResult: boolean;
  aborted: boolean;
}): boolean {
  return turnActive && !sawResult && !aborted;
}
