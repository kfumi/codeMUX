import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OpenCodeExecutableResolution {
  executablePath: string;
  pathEntry: string;
  source: 'runtime';
}

export interface ResolveOpenCodeExecutableParams {
  platform?: NodeJS.Platform;
  fileExists?: (candidate: string) => boolean;
  /** 外部托管 Runtime 路径（来自 ProviderRuntimeRef）。 */
  runtimePath?: string;
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
  platform = process.platform,
  fileExists = fs.existsSync,
  runtimePath,
}: ResolveOpenCodeExecutableParams): OpenCodeExecutableResolution | undefined {
  if (!runtimePath) return undefined;

  const names = executableNames(platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const runtimeDirectories = [
    pathApi.resolve(runtimePath, 'node_modules', 'opencode-ai', 'bin'),
    pathApi.resolve(runtimePath, 'node_modules', '.bin'),
  ];
  for (const directory of runtimeDirectories) {
    const executablePath = existingCandidate(directory, names, fileExists, pathApi);
    if (executablePath) {
      return { executablePath, pathEntry: directory, source: 'runtime' };
    }
  }

  return undefined;
}

export function prepareOpenCodeExecutable(params: ResolveOpenCodeExecutableParams): OpenCodeExecutableResolution {
  const resolution = resolveOpenCodeExecutable(params);
  if (!resolution) {
    const hint = params.runtimePath
      ? `Runtime 路径 ${params.runtimePath} 中未找到 opencode 可执行文件`
      : '未提供托管 OpenCode Runtime 路径';
    throw new Error(`OpenCode executable not found. ${hint}`);
  }

  const currentEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!currentEntries.includes(resolution.pathEntry)) {
    process.env.PATH = [resolution.pathEntry, ...currentEntries].join(path.delimiter);
  }
  return resolution;
}




