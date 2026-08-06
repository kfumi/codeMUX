// Runtime Pack 构建逻辑。
//
// 从 sidecar 的 node_modules 中组装指定 Provider 的 Runtime Pack，生成可验证的
// manifest（含 SHA-256、大小、签名、关键文件列表）和 Pack zip。
//
// 每个 Pack 仅包含对应 SDK、平台相关二进制、传递依赖和最小 manifest，避免 Provider
// 内容串包。构建测试能发现内容串包、元数据不一致和关键文件缺失。

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile, copyFile, mkdirSync } from "node:fs/promises";
import path from "node:path";
import { createDeflateRaw, deflateRawSync, gunzipSync, gzipSync, unzipSync } from "node:zlib";

/** Provider 规格：SDK 包名、平台二进制包名、关键文件、关键二进制。 */
export const PROVIDER_SPECS = Object.freeze({
  claude_code: Object.freeze({
    provider: "claude_code",
    label: "Claude Code",
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    /** 平台二进制包名前缀，实际包名为 `${prefix}-${platform}-${arch}`。 */
    platformBinaryPrefix: "@anthropic-ai/claude-agent-sdk",
    /** 平台二进制文件名（Windows x64）。 */
    keyBinariesByTarget: Object.freeze({
      "windows-x64": ["claude.exe"],
      "macos-x64": ["claude"],
      "macos-arm64": ["claude"],
      "linux-x64": ["claude"],
      "linux-arm64": ["claude"],
    }),
    keyFiles: ["package.json"],
  }),
  codex: Object.freeze({
    provider: "codex",
    label: "Codex",
    sdkPackage: "@openai/codex-sdk",
    platformBinaryPrefix: null,
    keyBinariesByTarget: Object.freeze({
      "windows-x64": [],
      "macos-x64": [],
      "macos-arm64": [],
      "linux-x64": [],
      "linux-arm64": [],
    }),
    keyFiles: ["package.json"],
  }),
  opencode: Object.freeze({
    provider: "opencode",
    label: "OpenCode",
    sdkPackage: "@opencode-ai/sdk",
    /** opencode-ai 是携带 CLI 二进制的包。 */
    altSdkPackage: "opencode-ai",
    platformBinaryPrefix: null,
    keyBinariesByTarget: Object.freeze({
      "windows-x64": ["bin/opencode.exe", "bin/opencode.cmd"],
      "macos-x64": ["bin/opencode"],
      "macos-arm64": ["bin/opencode"],
      "linux-x64": ["bin/opencode"],
      "linux-arm64": ["bin/opencode"],
    }),
    keyFiles: ["package.json"],
  }),
});

/** manifest schema 版本，与 Rust `MANIFEST_SCHEMA_VERSION` 对齐。 */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 将 manifest 平台名映射为 npm 平台二进制包名后缀。
 *
 * manifest 使用 `windows`/`macos`/`linux`（与 Rust target_os 对齐），
 * 但 npm 包命名约定使用 `win32`/`darwin`/`linux`（与 Node process.platform 对齐）。
 */
export function npmPlatformName(platform) {
  switch (platform) {
    case "windows":
      return "win32";
    case "macos":
      return "darwin";
    case "linux":
      return "linux";
    default:
      return platform;
  }
}

/** 目标标识。 */
export function targetString(platform, arch) {
  return `${platform}-${arch}`;
}

/**
 * 计算文件的 SHA-256（小写十六进制）。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** 计算字节的 SHA-256（小写十六进制）。 */
export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 收集指定目录下所有文件的相对路径（POSIX 风格）。
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function collectRelativeFiles(dir) {
  const results = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" && current !== dir) {
          // 只收集顶层 node_modules 下的内容，不递归嵌套的 node_modules
          // 实际上 npm 会 hoist，嵌套 node_modules 罕见；保留此分支以避免重复。
        }
        await walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join("/");
        results.push(rel);
      }
    }
  }
  if (existsSync(dir)) {
    await walk(dir);
  }
  return results.sort();
}

/**
 * 递归复制目录。
 * @param {string} src
 * @param {string} dest
 */
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath);
    }
  }
}

/**
 * 组装 Runtime Pack 到暂存目录。
 *
 * 从 `sourceNodeModules` 复制 SDK 包及其平台二进制包到 `stagingDir/node_modules/`。
 * 仅复制指定 Provider 相关的包，避免内容串包。
 *
 * @param {object} params
 * @param {string} params.provider Provider 标识。
 * @param {string} params.platform 目标平台。
 * @param {string} params.arch 目标架构。
 * @param {string} params.sourceNodeModules sidecar 的 node_modules 路径。
 * @param {string} params.stagingDir 暂存目录路径。
 * @returns {Promise<{ keyFiles: string[], keyBinaries: string[] }>}
 */
export async function stagePack(params) {
  const { provider, platform, arch, sourceNodeModules, stagingDir } = params;
  const spec = PROVIDER_SPECS[provider];
  if (!spec) {
    throw new Error(`未知 Provider: ${provider}`);
  }

  const target = targetString(platform, arch);
  const destNodeModules = path.join(stagingDir, "node_modules");
  await mkdir(destNodeModules, { recursive: true });

  const copiedPackages = [];

  // 复制主 SDK 包
  const sdkPath = path.join(sourceNodeModules, spec.sdkPackage);
  if (!existsSync(sdkPath)) {
    throw new Error(`${provider} SDK 包不存在: ${spec.sdkPackage} (在 ${sourceNodeModules})`);
  }
  const sdkDest = path.join(destNodeModules, spec.sdkPackage);
  await copyDir(sdkPath, sdkDest);
  copiedPackages.push(spec.sdkPackage);

  // 复制备用 SDK 包（opencode-ai）
  if (spec.altSdkPackage) {
    const altPath = path.join(sourceNodeModules, spec.altSdkPackage);
    if (existsSync(altPath)) {
      const altDest = path.join(destNodeModules, spec.altSdkPackage);
      await copyDir(altPath, altDest);
      copiedPackages.push(spec.altSdkPackage);
    }
  }

  // 复制平台二进制包
  if (spec.platformBinaryPrefix) {
    // npm 包命名使用 win32/darwin/linux，而非 manifest 的 windows/macos/linux。
    const npmPlatform = npmPlatformName(platform);
    const binaryPkg = `${spec.platformBinaryPrefix}-${npmPlatform}-${arch}`;
    const binaryPath = path.join(sourceNodeModules, binaryPkg);
    if (existsSync(binaryPath)) {
      const binaryDest = path.join(destNodeModules, binaryPkg);
      await copyDir(binaryPath, binaryDest);
      copiedPackages.push(binaryPkg);
    }
  }

  // 复制 SDK 的传递依赖（读取 SDK package.json 的 dependencies）
  const sdkPkgJsonPath = path.join(sdkPath, "package.json");
  if (existsSync(sdkPkgJsonPath)) {
    const sdkPkgJson = JSON.parse(readFileSync(sdkPkgJsonPath, "utf8"));
    const deps = sdkPkgJson.dependencies || {};
    for (const depName of Object.keys(deps)) {
      const depPath = path.join(sourceNodeModules, depName);
      if (existsSync(depPath) && !copiedPackages.includes(depName)) {
        const depDest = path.join(destNodeModules, depName);
        await copyDir(depPath, depDest);
        copiedPackages.push(depName);
      }
    }
  }

  // 解析关键文件和关键二进制的相对路径
  const keyFiles = [];
  for (const kf of spec.keyFiles) {
    const relPath = `${spec.sdkPackage}/${kf}`;
    keyFiles.push(relPath);
  }

  const keyBinaries = [];
  const targetBinaries = spec.keyBinariesByTarget[target] || [];
  for (const bin of targetBinaries) {
    if (spec.platformBinaryPrefix) {
      const npmPlatform = npmPlatformName(platform);
      const binaryPkg = `${spec.platformBinaryPrefix}-${npmPlatform}-${arch}`;
      keyBinaries.push(`${binaryPkg}/${bin}`);
    } else if (spec.altSdkPackage) {
      keyBinaries.push(`${spec.altSdkPackage}/${bin}`);
    } else {
      keyBinaries.push(`${spec.sdkPackage}/${bin}`);
    }
  }

  return { keyFiles, keyBinaries, copiedPackages };
}

/**
 * 校验暂存目录中的关键文件和关键二进制是否存在。
 * @param {string} stagingDir
 * @param {string[]} keyFiles
 * @param {string[]} keyBinaries
 * @returns {{ ok: boolean, missingFiles: string[], missingBinaries: string[] }}
 */
export function verifyKeyFiles(stagingDir, keyFiles, keyBinaries) {
  const missingFiles = [];
  const missingBinaries = [];
  for (const kf of keyFiles) {
    if (!existsSync(path.join(stagingDir, kf))) {
      missingFiles.push(kf);
    }
  }
  for (const kb of keyBinaries) {
    if (!existsSync(path.join(stagingDir, kb))) {
      missingBinaries.push(kb);
    }
  }
  return {
    ok: missingFiles.length === 0 && missingBinaries.length === 0,
    missingFiles,
    missingBinaries,
  };
}

/**
 * 构建 Runtime manifest。
 *
 * @param {object} params
 * @param {string} params.provider
 * @param {string} params.version Runtime 版本。
 * @param {string} params.platform
 * @param {string} params.arch
 * @param {string} params.downloadUrl Pack 下载 URL。
 * @param {number} params.sizeBytes Pack zip 大小（字节）。
 * @param {string} params.sha256 Pack zip 的 SHA-256。
 * @param {string} params.signature Pack zip 的签名。
 * @param {string} params.sidecarCompat 兼容的 sidecar 版本范围。
 * @param {string[]} params.keyFiles
 * @param {string[]} params.keyBinaries
 * @returns {object} manifest 对象
 */
export function buildManifest(params) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    provider: params.provider,
    version: params.version,
    platform: params.platform,
    arch: params.arch,
    asset: {
      url: params.downloadUrl,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
      signature: params.signature,
    },
    sidecarCompat: params.sidecarCompat,
    keyFiles: params.keyFiles,
    keyBinaries: params.keyBinaries,
    createdAt: new Date().toISOString(),
  };
  return manifest;
}

/**
 * 校验 manifest 自身字段一致性（不依赖文件系统）。
 * @param {object} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion 不匹配：期望 ${MANIFEST_SCHEMA_VERSION}，实际 ${manifest.schemaVersion}`);
  }
  if (!PROVIDER_SPECS[manifest.provider]) {
    errors.push(`未知 provider: ${manifest.provider}`);
  }
  if (!manifest.version || !manifest.version.trim()) {
    errors.push("version 为空");
  }
  if (!["windows", "macos", "linux"].includes(manifest.platform)) {
    errors.push(`未知 platform: ${manifest.platform}`);
  }
  if (!["x64", "arm64"].includes(manifest.arch)) {
    errors.push(`未知 arch: ${manifest.arch}`);
  }
  if (!manifest.asset || !manifest.asset.url || !manifest.asset.url.trim()) {
    errors.push("asset.url 为空");
  }
  if (!manifest.asset || !manifest.asset.sizeBytes || manifest.asset.sizeBytes <= 0) {
    errors.push("asset.sizeBytes 无效");
  }
  const sha = manifest.asset?.sha256 ?? "";
  if (sha.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(sha)) {
    errors.push("asset.sha256 不是合法的 SHA-256");
  }
  if (!manifest.asset || !manifest.asset.signature || !manifest.asset.signature.trim()) {
    errors.push("asset.signature 为空");
  }
  if (!manifest.sidecarCompat || !manifest.sidecarCompat.trim()) {
    errors.push("sidecarCompat 为空");
  }
  if (!Array.isArray(manifest.keyFiles) || manifest.keyFiles.length === 0) {
    errors.push("keyFiles 为空或非数组");
  }
  if (!Array.isArray(manifest.keyBinaries)) {
    errors.push("keyBinaries 不是数组");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 检测两个 Provider 的 Pack 内容是否串包。
 *
 * 通过检查 manifest 的 keyFiles/keyBinaries 是否引用了属于其他 Provider 的包。
 * @param {object} manifest
 * @returns {{ ok: boolean, contaminations: string[] }}
 */
export function detectCrossContamination(manifest) {
  const contaminations = [];
  const ownerProvider = manifest.provider;
  const ownerSpec = PROVIDER_SPECS[ownerProvider];
  if (!ownerSpec) {
    return { ok: false, contaminations: [`未知 provider: ${ownerProvider}`] };
  }

  // 收集所有其他 Provider 的 SDK 包名和平台二进制包前缀
  const foreignPackages = [];
  for (const [prov, spec] of Object.entries(PROVIDER_SPECS)) {
    if (prov === ownerProvider) continue;
    foreignPackages.push(spec.sdkPackage);
    if (spec.altSdkPackage) foreignPackages.push(spec.altSdkPackage);
    if (spec.platformBinaryPrefix) foreignPackages.push(spec.platformBinaryPrefix);
  }

  const allPaths = [...(manifest.keyFiles || []), ...(manifest.keyBinaries || [])];
  for (const p of allPaths) {
    for (const foreign of foreignPackages) {
      if (p.startsWith(foreign + "/") || p === foreign) {
        contaminations.push(`路径 ${p} 引用了属于其他 Provider 的包 ${foreign}`);
      }
    }
  }
  return { ok: contaminations.length === 0, contaminations };
}
