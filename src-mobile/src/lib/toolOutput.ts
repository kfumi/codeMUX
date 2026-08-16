function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractExitCode(text: string): number | null {
  const match = text.match(/(?:exit code|exit_code|exit status)[:\s]+(-?\d+)/i);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

export function hasExplicitFailureSignal(value: unknown): boolean {
  if (value == null) {
    return false;
  }

  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      return hasExplicitFailureSignal(parsed);
    }

    const exitCode = extractExitCode(value);
    return exitCode != null && exitCode !== 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasExplicitFailureSignal(item));
  }

  if (!isRecord(value)) {
    return false;
  }

  if (
    value.is_error === true
    || value.error === true
    || value.success === false
    || value.ok === false
  ) {
    return true;
  }

  const exitCode = value.exit_code ?? value.exitCode ?? value.return_code ?? value.returnCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return true;
  }

  return false;
}

export function formatShellCommandOutput(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }

  if (typeof result === 'string') {
    const parsed = tryParseJson(result);
    if (parsed !== undefined) {
      return formatShellCommandOutput(parsed);
    }
    return result;
  }

  if (isRecord(result)) {
    const parts = ['stdout', 'stderr', 'output']
      .map((key) => result[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function resolveToolStatus(
  status: 'running' | 'complete' | 'error',
  result: string | undefined,
): 'running' | 'complete' | 'error' {
  if (status === 'running') {
    return 'running';
  }
  if (status === 'error' || hasExplicitFailureSignal(result)) {
    return 'error';
  }
  return 'complete';
}
