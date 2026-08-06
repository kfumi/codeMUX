import * as fs from 'node:fs';
import * as path from 'node:path';

type SupportedPlatform = NodeJS.Platform;
type SupportedArch = NodeJS.Architecture;

type ResolveClaudeExecutableParams = {
  arch?: SupportedArch;
  fileExists?: (candidate: string) => boolean;
  pathClaude?: string;
  platform?: SupportedPlatform;
  sidecarDir: string;
  /** 外部 Runtime 路径（来自 ProviderRuntimeRef）。优先于 bundled 和 PATH。 */
  runtimePath?: string;
};

function packageNameFor(platform: SupportedPlatform, arch: SupportedArch): string | undefined {
  const suffix = (() => {
    switch (arch) {
      case 'x64':
        return 'x64';
      case 'arm64':
        return 'arm64';
      default:
        return undefined;
    }
  })();

  if (!suffix) return undefined;

  switch (platform) {
    case 'win32':
      return `@anthropic-ai/claude-agent-sdk-win32-${suffix}`;
    case 'darwin':
      return `@anthropic-ai/claude-agent-sdk-darwin-${suffix}`;
    case 'linux':
      return `@anthropic-ai/claude-agent-sdk-linux-${suffix}`;
    default:
      return undefined;
  }
}

function binaryNameFor(platform: SupportedPlatform): string {
  return platform === 'win32' ? 'claude.exe' : 'claude';
}

function bundledClaudePath(sidecarDir: string, platform: SupportedPlatform, arch: SupportedArch): string | undefined {
  const packageName = packageNameFor(platform, arch);
  if (!packageName) return undefined;

  return path.resolve(sidecarDir, '..', 'node_modules', packageName, binaryNameFor(platform));
}

function runtimeClaudePath(runtimePath: string, platform: SupportedPlatform, arch: SupportedArch): string | undefined {
  const packageName = packageNameFor(platform, arch);
  if (!packageName) return undefined;

  return path.resolve(runtimePath, 'node_modules', packageName, binaryNameFor(platform));
}

export function resolveClaudeExecutable(params: ResolveClaudeExecutableParams): string | undefined {
  const {
    arch = process.arch,
    fileExists = fs.existsSync,
    pathClaude,
    platform = process.platform,
    sidecarDir,
    runtimePath,
  } = params;

  // 优先：外部 Runtime 路径
  if (runtimePath) {
    const runtimePath_result = runtimeClaudePath(runtimePath, platform, arch);
    if (runtimePath_result && fileExists(runtimePath_result)) {
      return runtimePath_result;
    }
  }

  // 次选：bundled node_modules（向后兼容，Ticket 07 移除）
  const bundled = bundledClaudePath(sidecarDir, platform, arch);
  if (bundled && fileExists(bundled)) {
    return bundled;
  }

  // 兜底：PATH 上的 claude
  if (pathClaude && fileExists(pathClaude)) {
    return pathClaude;
  }

  return undefined;
}
