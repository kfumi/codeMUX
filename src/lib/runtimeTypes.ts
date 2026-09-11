/**
 * CodeMUX 托管 SDK Runtime 契约(与 Rust `runtime` 模块对齐)。
 * 描述由 CodeMUX 自己管理、可验证、可回滚且与用户全局 CLI 解耦的 SDK Runtime。
 * (原 src/lib/tauri.ts 契约段,Tauri 壳退役后迁至本模块。)
 */

/** CodeMUX 托管的 Provider Runtime 种类。 */
export type RuntimeProvider = 'claude_code' | 'codex' | 'opencode' | 'pi';

/** 目标平台。 */
export type RuntimePlatform = 'windows' | 'macos' | 'linux';

/** CPU 架构。 */
export type RuntimeArch = 'x64' | 'arm64';

/**
 * CodeMUX 自有 Runtime 状态。
 * 不得由外部 CLI 缺失推导为不可用。
 */
export type ManagedRuntimeStatus =
  | 'missing'
  | 'installing'
  | 'ready'
  | 'outdated'
  | 'corrupted'
  | 'node_unavailable'
  | 'error';

/** 安装 / 升级 / 修复流程的阶段。 */
export type RuntimeInstallStage =
  | 'resolving'
  | 'downloading'
  | 'verifying_integrity'
  | 'switching'
  | 'cleaning'
  | 'done'
  | 'failed';

/** Runtime 操作错误种类。 */
export type RuntimeErrorKind =
  | 'manifest_failed'
  | 'download_failed'
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
export interface RuntimeErrorInfo {
  kind: RuntimeErrorKind;
  provider?: RuntimeProvider;
  stage?: RuntimeInstallStage;
  message: string;
  recoverable: boolean;
}

/** 安装进度。 */
export interface RuntimeInstallProgress {
  stage: RuntimeInstallStage;
  percent?: number;
  bytesDone?: number;
  bytesTotal?: number;
  message?: string;
}

/** Runtime 完整性校验结果。 */
export interface RuntimeIntegrityResult {
  ok: boolean;
  missingFiles: string[];
  missingBinaries: string[];
  message: string;
}

/** 系统 Node.js 检测结果。 */
export interface NodeDetection {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  satisfiesMinimum: boolean;
  error: string | null;
}

/** 单个 Provider 的 Runtime 检测结果。 */
export interface ManagedRuntimeInfo {
  provider: RuntimeProvider;
  label: string;
  status: ManagedRuntimeStatus;
  currentVersion: string | null;
  installedVersions: string[];
  availableVersions: string[];
  installPath: string | null;
  runtimeRoot: string;
  integrityOk: boolean;
  message: string;
}

/** Node.js 检测信息(与 Rust `NodeInfo` 对齐)。 */
export interface ManagedNodeInfo {
  available: boolean;
  satisfiesMinimum: boolean;
  version: string | null;
  executablePath: string | null;
  error: string | null;
  npm: ManagedNpmInfo;
}

export interface ManagedNpmInfo {
  available: boolean;
  version: string | null;
  executablePath: string | null;
  matchesNode: boolean;
  error: string | null;
}

/** 一次托管 Runtime 检测的聚合结果。 */
export interface ManagedRuntimeCheckResult {
  checkedAt: string;
  node: ManagedNodeInfo;
  runtimes: ManagedRuntimeInfo[];
}

/** 安装 / 升级 / 修复操作的结果。 */
export interface ManagedRuntimeOperationResult {
  provider: RuntimeProvider;
  label: string;
  previousVersion: string | null;
  installedVersion: string;
  installPath: string;
  switched: boolean;
}

/** Runtime 安装进度事件 payload(daemon → 壳 → desktopBridge.onDesktopEvent 转发)。 */
export interface RuntimeInstallProgressEvent {
  provider: RuntimeProvider;
  progress: RuntimeInstallProgress;
}
