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
  /** 外部 Runtime 路径（来自 ProviderRuntimeRef）。优先于 bundled 和 PATH。 */
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
  sidecarDir,
  platform = process.platform,
  pathEnv = process.env.PATH,
  fileExists = fs.existsSync,
  runtimePath,
}: ResolveOpenCodeExecutableParams): OpenCodeExecutableResolution | undefined {
  const names = executableNames(platform);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = pathApi.delimiter;

  // 优先：外部 Runtime 路径
  const runtimeDirectories: string[] = [];
  if (runtimePath) {
    runtimeDirectories.push(
      pathApi.resolve(runtimePath, 'node_modules', 'opencode-ai', 'bin'),
      pathApi.resolve(runtimePath, 'node_modules', '.bin'),
    );
  }
  for (const directory of runtimeDirectories) {
    const executablePath = existingCandidate(directory, names, fileExists, pathApi);
    if (executablePath) {
      return { executablePath, pathEntry: directory, source: 'bundled' };
    }
  }

  // 次选：bundled node_modules（向后兼容，Ticket 07 移除）
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
    const hint = params.runtimePath
      ? `Runtime 路径 ${params.runtimePath} 中未找到 opencode 可执行文件`
      : 'Install the bundled OpenCode runtime or make `opencode` available on PATH.';
    throw new Error(`OpenCode executable not found. ${hint}`);
  }

  const currentEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!currentEntries.includes(resolution.pathEntry)) {
    process.env.PATH = [resolution.pathEntry, ...currentEntries].join(path.delimiter);
  }
  return resolution;
}




