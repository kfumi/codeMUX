import * as fs from 'node:fs';
import * as path from 'node:path';

type SupportedPlatform = NodeJS.Platform;
type SupportedArch = NodeJS.Architecture;

type ResolveClaudeExecutableParams = {
  arch?: SupportedArch;
  fileExists?: (candidate: string) => boolean;
  platform?: SupportedPlatform;
  /** 外部托管 Runtime 路径（来自 ProviderRuntimeRef）。 */
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

function runtimeClaudePath(runtimePath: string, platform: SupportedPlatform, arch: SupportedArch): string | undefined {
  const packageName = packageNameFor(platform, arch);
  if (!packageName) return undefined;

  return path.resolve(runtimePath, 'node_modules', packageName, binaryNameFor(platform));
}

export function resolveClaudeExecutable(params: ResolveClaudeExecutableParams): string | undefined {
  const {
    arch = process.arch,
    fileExists = fs.existsSync,
    platform = process.platform,
    runtimePath,
  } = params;

  if (!runtimePath) return undefined;

  const runtimeClaude = runtimeClaudePath(runtimePath, platform, arch);
  if (runtimeClaude && fileExists(runtimeClaude)) {
    return runtimeClaude;
  }

  return undefined;
}
