/**
 * 错误文案提取。
 *
 * daemon 的错误响应体统一是 `{"error":"当前项目不是 Git 仓库"}`
 * (见 `crates/daemon/src/companion/server.rs` 的 `ApiError::into_response`),
 * 而 `daemonFetch` 过去直接把响应体塞进 `Error.message`,导致界面显示成
 * `Error: {"error":"当前项目不是 Git 仓库"}` —— JSON 原样暴露给用户。
 * 这里把信封拆开,只留里面的文案。
 */

/** 从错误响应体里取出可读文案:支持 `{"error":…}` / `{"message":…}` / `{"msg":…}` 与嵌套 `{"error":{"message":…}}`。 */
export function extractErrorText(body: string, fallback: string): string {
  const trimmed = body.trim();
  if (!trimmed) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }

  const message = readMessage(parsed);
  return message ?? trimmed;
}

/**
 * 展示用错误文案:`Error` 只取 `.message`(去掉 `Error: ` 前缀),
 * 字符串原样返回但仍会拆 JSON 信封,非 Error 值兜底 `String()`。
 */
export function formatErrorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof Error) {
    return extractErrorText(error.message, error.message.trim() || fallback);
  }
  if (typeof error === 'string') {
    return extractErrorText(error, error.trim() || fallback);
  }
  if (error === null || error === undefined) {
    return fallback;
  }

  const message = readMessage(error);
  if (message) return message;

  try {
    return String(error);
  } catch {
    return fallback;
  }
}

function readMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['error', 'message', 'msg'] as const) {
    const message = readMessage(record[key]);
    if (message) return message;
  }

  return undefined;
}
