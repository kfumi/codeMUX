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

export function resolveClaudeExecutable(params: ResolveClaudeExecutableParams): string | undefined {
  const {
    arch = process.arch,
    fileExists = fs.existsSync,
    pathClaude,
    platform = process.platform,
    sidecarDir,
  } = params;

  const bundled = bundledClaudePath(sidecarDir, platform, arch);
  if (bundled && fileExists(bundled)) {
    return bundled;
  }

  if (pathClaude && fileExists(pathClaude)) {
    return pathClaude;
  }

  return undefined;
}
