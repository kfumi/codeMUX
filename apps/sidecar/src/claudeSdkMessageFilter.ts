const FORWARDED_SYSTEM_SUBTYPES = new Set([
  'api_retry',
  'compact_boundary',
  'init',
]);

/** Claude task protocol frames observed by the subagent adapter before dropping. */
const TASK_SYSTEM_SUBTYPES = new Set([
  'task_started',
  'task_updated',
  'task_progress',
  'task_notification',
]);

export function isClaudeSidechainMessage(message: Record<string, unknown>): boolean {
  return message.isSidechain === true
    || (typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id.length > 0);
}

export function isClaudeTaskNotification(message: Record<string, unknown>): boolean {
  const origin = message.origin;
  const originKind = origin && typeof origin === 'object' && !Array.isArray(origin)
    ? (origin as Record<string, unknown>).kind
    : undefined;
  return originKind === 'task-notification'
    || originKind === 'task_notification'
    || (message.type === 'system' && message.subtype === 'task_notification');
}

export function isClaudeTaskProtocolMessage(message: Record<string, unknown>): boolean {
  return isClaudeSidechainMessage(message)
    || isClaudeTaskNotification(message)
    || (message.type === 'system'
      && typeof message.subtype === 'string'
      && TASK_SYSTEM_SUBTYPES.has(message.subtype));
}

/**
 * Keep the SDK wire seam limited to messages that are rendered or consumed by
 * the turn state machine. Claude emits progress/status messages separately
 * from the transcript and some of them can arrive once per tool update.
 */
export function shouldForwardClaudeSdkMessage(message: Record<string, unknown>): boolean {
  if (isClaudeSidechainMessage(message) || isClaudeTaskNotification(message)) {
    return false;
  }

  if (message.type === 'assistant' || message.type === 'user' || message.type === 'result' || message.type === 'stream_event') {
    return true;
  }

  return message.type === 'system'
    && typeof message.subtype === 'string'
    && FORWARDED_SYSTEM_SUBTYPES.has(message.subtype);
}
