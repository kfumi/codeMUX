export type BrowserUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

const HTTP_SCHEMES = new Set(['http:', 'https:']);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function normalizeBrowserUrl(input: string): BrowserUrlResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: '请输入网址' };
  }

  const schemeMatch = trimmed.match(SCHEME_PATTERN);
  if (schemeMatch && !['http', 'https'].includes(schemeMatch[1].toLowerCase())) {
    return { ok: false, error: '只允许 http 或 https 地址' };
  }

  const candidate = trimmed.includes('://')
    ? trimmed
    : trimmed.startsWith('//')
      ? `https:${trimmed}`
      : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: '网址无效' };
  }

  if (!HTTP_SCHEMES.has(parsed.protocol)) {
    return { ok: false, error: '只允许 http 或 https 地址' };
  }

  if (!parsed.hostname) {
    return { ok: false, error: '网址无效' };
  }

  return { ok: true, url: parsed.toString() };
}
