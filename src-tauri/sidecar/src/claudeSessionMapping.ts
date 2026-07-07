export function shouldCaptureClaudeSessionMapping(message: Record<string, unknown>): boolean {
  if (typeof message.session_id !== 'string' || message.session_id.trim().length === 0) {
    return false;
  }

  if (
    message.type === 'result' &&
    (message.subtype === 'error_during_execution' || message.is_error === true)
  ) {
    return false;
  }

  return true;
}
