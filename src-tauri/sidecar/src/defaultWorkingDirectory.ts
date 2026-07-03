import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_NON_PROJECT_FOLDER = 'CodemuxProject';

export function resolveDefaultWorkingDirectory(homeDir = os.homedir()): string {
  return path.join(homeDir, DEFAULT_NON_PROJECT_FOLDER);
}

export function isDefaultWorkingDirectoryRequest(cwd: string | undefined | null): boolean {
  const normalized = cwd?.trim();
  return !normalized || normalized === '.';
}

export function resolveWorkingDirectory(cwd: string | undefined | null, homeDir = os.homedir()): string {
  if (isDefaultWorkingDirectoryRequest(cwd)) {
    return resolveDefaultWorkingDirectory(homeDir);
  }

  return cwd as string;
}

export function ensureWorkingDirectory(cwd: string | undefined | null, homeDir = os.homedir()): string {
  const resolved = resolveWorkingDirectory(cwd, homeDir);
  if (isDefaultWorkingDirectoryRequest(cwd)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}
