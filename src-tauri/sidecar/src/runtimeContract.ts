// CodeMUX 托管 SDK Runtime 领域契约（sidecar 共享类型）。
//
// 本文件镜像 Rust `src-tauri/src/runtime` 模块的核心契约，供 sidecar 的 Runtime loader
// （Ticket 04）和未来的检测逻辑共享同一命名。来自 Rust 的 ensure_session 命令会携带
// Provider Runtime 路径，sidecar 据此动态加载 SDK。

/** CodeMUX 托管的 Provider Runtime 种类。值与 Rust `Provider::as_str()` 对齐。 */
export type Provider = 'claude_code' | 'codex' | 'opencode';

/** 目标平台。 */
export type RuntimePlatform = 'windows' | 'macos' | 'linux';

/** CPU 架构。 */
export type RuntimeArch = 'x64' | 'arm64';

/** Runtime 状态。描述 CodeMUX 自有 Runtime，不得由外部 CLI 缺失推导为不可用。 */
export type RuntimeStatus =
  | 'missing'
  | 'installing'
  | 'ready'
  | 'outdated'
  | 'corrupted'
  | 'node_unavailable'
  | 'error';

/** 安装 / 升级 / 修复流程的阶段。 */
export type InstallStage =
  | 'resolving'
  | 'downloading'
  | 'verifying_signature'
  | 'verifying_hash'
  | 'extracting'
  | 'verifying_integrity'
  | 'switching'
  | 'cleaning'
  | 'done'
  | 'failed';

/** Runtime 操作错误种类。 */
export type RuntimeErrorKind =
  | 'manifest_failed'
  | 'download_failed'
  | 'signature_error'
  | 'hash_mismatch'
  | 'extract_failed'
  | 'integrity_failed'
  | 'compatibility_failed'
  | 'permission_failed'
  | 'node_unavailable'
  | 'rollback_failed'
  | 'busy'
  | 'cancelled'
  | 'io_failed'
  | 'unknown';

/** 结构化 Runtime 错误。 */
export interface RuntimeError {
  kind: RuntimeErrorKind;
  provider?: Provider;
  stage?: InstallStage;
  message: string;
  recoverable: boolean;
}

/** 安装进度。 */
export interface RuntimeProgress {
  stage: InstallStage;
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  message?: string;
}

/** Runtime Pack manifest 中的下载资产描述。 */
export interface RuntimeManifestAsset {
  url: string;
  sizeBytes: number;
  sha256: string;
  signature: string;
}

/** Runtime Pack manifest。 */
export interface RuntimeManifest {
  schemaVersion: number;
  provider: Provider;
  version: string;
  platform: RuntimePlatform;
  arch: RuntimeArch;
  asset: RuntimeManifestAsset;
  sidecarCompat: string;
  keyFiles: string[];
  keyBinaries: string[];
  createdAt: string;
}

/**
 * Rust 启动 sidecar 时通过 ensure_session 命令传入的 Runtime 解析结果。
 * sidecar 据此从显式路径加载 SDK，不再读取用户全局 npm 目录。
 */
export interface ProviderRuntimeRef {
  /** Provider 标识。 */
  provider: Provider;
  /** Runtime 根目录（例如 %LOCALAPPDATA%\CodeMUX\runtimes）。 */
  runtimeRoot: string;
  /** 当前 Provider Runtime 版本目录绝对路径（例如 <root>/claude_code/0.3.169）。 */
  runtimePath: string;
  /** 当前 Runtime 版本。 */
  runtimeVersion: string;
  /** 兼容的 sidecar 版本范围（来自 manifest，仅用于诊断展示）。 */
  sidecarCompat?: string;
}

/** 校验 ProviderRuntimeRef 必填字段非空。 */
export function validateProviderRuntimeRef(ref: ProviderRuntimeRef): RuntimeError | null {
  if (!ref.provider) {
    return { kind: 'unknown', message: 'ProviderRuntimeRef.provider 为空', recoverable: false };
  }
  if (!ref.runtimePath.trim()) {
    return {
      kind: 'integrity_failed',
      provider: ref.provider,
      stage: 'verifying_integrity',
      message: 'ProviderRuntimeRef.runtimePath 为空',
      recoverable: false,
    };
  }
  if (!ref.runtimeVersion.trim()) {
    return {
      kind: 'integrity_failed',
      provider: ref.provider,
      stage: 'verifying_integrity',
      message: 'ProviderRuntimeRef.runtimeVersion 为空',
      recoverable: false,
    };
  }
  return null;
}

/** Provider 展示名（与 Rust `Provider::label()` 对齐）。 */
export function providerLabel(provider: Provider): string {
  switch (provider) {
    case 'claude_code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
  }
}

/** Provider 对应的全局 CLI 命令名（仅用于外部 CLI 诊断）。 */
export function providerCliCommand(provider: Provider): string {
  switch (provider) {
    case 'claude_code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
  }
}

/** 判定一个值是否为合法的 Provider。 */
export function isProvider(value: unknown): value is Provider {
  return value === 'claude_code' || value === 'codex' || value === 'opencode';
}
