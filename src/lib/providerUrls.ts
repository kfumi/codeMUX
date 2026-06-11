const OPENAI_ENDPOINT_SUFFIXES = [
  '/codex/responses',
  '/v1/chat/completions',
  '/chat/completions',
  '/v1/responses',
  '/responses',
  '/v1/models',
  '/models',
  '/v1',
] as const;

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function normalizeOpenAIBaseUrl(baseUrl: string): string {
  let normalized = stripTrailingSlash(baseUrl.trim());

  for (const suffix of OPENAI_ENDPOINT_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length);
      break;
    }
  }

  return stripTrailingSlash(normalized);
}

export function getOpenAIBaseUrlHint(baseUrl: string): string | null {
  const trimmed = stripTrailingSlash(baseUrl.trim());
  if (!trimmed) {
    return null;
  }

  const normalized = normalizeOpenAIBaseUrl(trimmed);
  if (normalized !== trimmed) {
    return `Use the provider base URL here, not a full endpoint. Suggested value: ${normalized}`;
  }

  return null;
}

export function humanizeCodexError(error: string): string {
  const compact = error.replace(/\s+/g, ' ').trim();
  const lower = compact.toLowerCase();

  if (lower.includes('no available codex subscription') || lower.includes('codex subscription')) {
    return 'The current provider accepted the request, but it does not grant Codex access. Pick a provider with Codex or Responses support for this session.';
  }

  if (lower.includes('unexpected status 403') && lower.includes('/codex/responses')) {
    return 'The current provider rejected Codex access (403 on /codex/responses). Pick a provider that supports Codex or Responses.';
  }

  if (lower.includes('/codex/responses') || lower.includes('/v1/responses')) {
    return `Codex request failed: ${compact}`;
  }

  return error;
}
