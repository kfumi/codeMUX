import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OpenCodeExecutableResolution {
  executablePath: string;
  pathEntry: string;
  source: 'bundled' | 'path';
}

export interface ResolveOpenCodeExecutableParams {
  sidecarDir: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  fileExists?: (candidate: string) => boolean;
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['opencode.cmd', 'opencode.exe', 'opencode'] : ['opencode'];
}

function existingCandidate(
  directory: string,
  names: string[],
  fileExists: (candidate: string) => boolean,
  pathApi: typeof path.posix,
): string | undefined {
  for (const name of names) {
    const candidate = pathApi.resolve(directory, name);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function resolveOpenCodeExecutable({
  sidecarDir,
  platform = process.platform,
  pathEnv = process.env.PATH,
  fileExists = fs.existsSync,
}: ResolveOpenCodeExecutableParams): OpenCodeExecutableResolution | undefined {
  const names = executableNames(platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = pathApi.delimiter;
  const bundledDirectories = [
    pathApi.resolve(sidecarDir, '..', 'node_modules', '.bin'),
    pathApi.resolve(sidecarDir, '..', 'node_modules', 'opencode-ai', 'bin'),
  ];

  for (const directory of bundledDirectories) {
    const executablePath = existingCandidate(directory, names, fileExists, pathApi);
    if (executablePath) {
      return { executablePath, pathEntry: directory, source: 'bundled' };
    }
  }

  const pathEntries = (pathEnv ?? '').split(delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    const executablePath = existingCandidate(directory, names, fileExists, pathApi);
    if (executablePath) {
      return { executablePath, pathEntry: directory, source: 'path' };
    }
  }

  return undefined;
}

export function prepareOpenCodeExecutable(params: ResolveOpenCodeExecutableParams): OpenCodeExecutableResolution {
  const resolution = resolveOpenCodeExecutable(params);
  if (!resolution) {
    throw new Error('OpenCode executable not found. Install the bundled OpenCode runtime or make `opencode` available on PATH.');
  }

  const currentEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!currentEntries.includes(resolution.pathEntry)) {
    process.env.PATH = [resolution.pathEntry, ...currentEntries].join(path.delimiter);
  }
  return resolution;
}




