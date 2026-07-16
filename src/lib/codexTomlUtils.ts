const TOML_BASE_URL_RE = /^(\s*base_url\s*=\s*)(["'])(.*?)\2\s*$/;
const TOML_MODEL_RE = /^(\s*model\s*=\s*)(["'])(.*?)\2\s*$/;

function getTopLevelEndIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^\[/.test(lines[i])) return i;
  }
  return lines.length;
}

function findTopLevelAssignment(lines: string[], pattern: RegExp): { index: number; value: string } | null {
  const end = getTopLevelEndIndex(lines);
  for (let i = 0; i < end; i++) {
    const m = lines[i].match(pattern);
    if (m) return { index: i, value: m[3] };
  }
  return null;
}

function upsertTopLevelAssignment(lines: string[], pattern: RegExp, replacementLine: string): string[] {
  const end = getTopLevelEndIndex(lines);
  for (let i = 0; i < end; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = replacementLine;
      return lines;
    }
  }
  const insertIdx = Math.min(end, lines.length);
  lines.splice(insertIdx, 0, replacementLine);
  return lines;
}

function finalizeTomlText(lines: string[]): string {
  const trimmed = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return trimmed.endsWith('\n') ? trimmed : trimmed + '\n';
}

export function extractCodexBaseUrl(configToml: string): string | null {
  if (!configToml.trim()) return null;
  const lines = configToml.split('\n');
  const match = findTopLevelAssignment(lines, TOML_BASE_URL_RE);
  return match?.value ?? null;
}

export function setCodexBaseUrl(configToml: string, baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const lines = (configToml || '').split('\n');
  if (!trimmed) {
    const end = getTopLevelEndIndex(lines);
    for (let i = 0; i < end; i++) {
      if (TOML_BASE_URL_RE.test(lines[i])) {
        lines.splice(i, 1);
        return finalizeTomlText(lines);
      }
    }
    return finalizeTomlText(lines);
  }
  const normalized = trimmed.replace(/\s+/g, '');
  const line = `base_url = "${normalized}"`;
  return finalizeTomlText(upsertTopLevelAssignment(lines, TOML_BASE_URL_RE, line));
}

export function extractCodexModelName(configToml: string): string | null {
  if (!configToml.trim()) return null;
  const lines = configToml.split('\n');
  const match = findTopLevelAssignment(lines, TOML_MODEL_RE);
  return match?.value ?? null;
}

export function setCodexModelName(configToml: string, model: string): string {
  const trimmed = model.trim();
  const lines = (configToml || '').split('\n');
  if (!trimmed) {
    const end = getTopLevelEndIndex(lines);
    for (let i = 0; i < end; i++) {
      if (TOML_MODEL_RE.test(lines[i])) {
        lines.splice(i, 1);
        return finalizeTomlText(lines);
      }
    }
    return finalizeTomlText(lines);
  }
  const line = `model = "${trimmed}"`;
  return finalizeTomlText(upsertTopLevelAssignment(lines, TOML_MODEL_RE, line));
}

export function generateCodexDefaultConfigToml(baseUrl?: string, model?: string): string {
  const m = model || 'gpt-5.6';
  const bUrl = baseUrl || '';
  const parts = [
    `model_provider = "custom"`,
    `model = "${m}"`,
    `model_reasoning_effort = "high"`,
    `disable_response_storage = true`,
    ``,
    `[model_providers.custom]`,
    `name = "custom"`,
    `base_url = "${bUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    '',
  ];
  return parts.join('\n');
}
