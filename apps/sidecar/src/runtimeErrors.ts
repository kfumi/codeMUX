/**
 * sidecar 运行时的通用错误判定。
 *
 * 这些错误来自四家原生 runtime（Claude 的会话恢复、OpenCode 的会话句柄、
 * Codex 的 thread 恢复），但判定规则不依赖任何一家；dispatcher 与
 * `claudeRuntime` 共用同一份，避免同一句话在两处各写一遍。
 */

/** 原生会话恢复失败：daemon 应转成 `session_resume_failed` 而不是普通错误。 */
export function isNativeResumeFailure(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return message.includes('no conversation found with session id')
    || message.includes('failed to restore opencode session')
    || message.includes('session not found')
    || message.includes('session does not exist')
    || message.includes('thread not found')
    || message.includes('thread does not exist')
    || message.includes('unable to resume')
    || message.includes('failed to resume');
}
