//! 安装包签名助手(工单 09 验收:签名链覆盖 Electron 应用与 daemon 二进制)。
//!
//! - Electron 应用本体:electron-builder 原生行为 —— 检测到 CSC_LINK /
//!   CSC_KEY_PASSWORD 环境变量即自动签名(无需配置)。
//! - extraResources 里的 daemon 二进制:electron-builder 不会碰,由
//!   scripts/sign-daemon.cjs(afterPack 钩子)调用本模块在打包时补签。
//!
//! 纯 Node 可测;真实的 signtool 调用只在打包机(CSC_LINK 已配置)发生。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** RFC3161 时间戳服务器(electron-builder 默认同款)。 */
const TIMESTAMP_URL = 'http://timestamp.digicert.com';

/** 已解码的签名材料:.pfx 文件路径 + 密码。 */
export interface SignMaterial {
  pfxPath: string;
  password: string | null;
  /** 临时解码出的 pfx(来自 base64 CSC_LINK)需要清理;文件路径形态为 null。 */
  tempDir: string | null;
}

/**
 * 把 CSC_LINK 统一成 .pfx 文件:
 * - 已是文件路径(存在)→ 直接用;
 * - data: URI 或裸 base64 → 解码到临时目录(调用方负责清理 tempDir)。
 */
export function resolveSignMaterial(cscLink: string, cscKeyPassword: string | null): SignMaterial {
  const trimmed = cscLink.trim();
  if (!trimmed.startsWith('data:') && !/^[A-Za-z0-9+/=]{512,}$/.test(trimmed)) {
    if (!existsSync(trimmed)) {
      throw new Error(`CSC_LINK 指向的证书文件不存在: ${trimmed}`);
    }
    return { pfxPath: trimmed, password: cscKeyPassword, tempDir: null };
  }
  const base64 = trimmed.startsWith('data:')
    ? trimmed.slice(trimmed.indexOf(',') + 1)
    : trimmed;
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'codemux-sign-'));
  const pfxPath = path.join(tempDir, 'cert.pfx');
  writeFileSync(pfxPath, Buffer.from(base64, 'base64'));
  return { pfxPath, password: cscKeyPassword, tempDir };
}

/** 组装 signtool 参数(签名 + RFC3161 时间戳;SHA256 全链)。 */
export function buildSignArgs(material: SignMaterial, targetPath: string): string[] {
  const args = ['/sign', '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256'];
  if (material.password) {
    args.push('/p', material.password);
  }
  args.push('/f', material.pfxPath, targetPath);
  return args;
}

/**
 * 定位 signtool:CODEMUX_SIGNTOOL_PATH 显式指定 → Windows Kits 各版本目录
 * 取最高版本 → PATH 上的 signtool。都找不到返回 null。
 * kitsRoot 可注入(测试确定性;缺省为标准 Windows Kits 位置)。
 */
export function resolveSigntoolPath(env: NodeJS.ProcessEnv, kitsRoot?: string): string | null {
  const explicit = env.CODEMUX_SIGNTOOL_PATH?.trim();
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  const resolvedKitsRoot = kitsRoot
    ?? path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Windows Kits',
      '10',
      'bin',
    );
  try {
    const versionDirs = readdirSync(resolvedKitsRoot)
      .filter((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry))
      .sort()
      .reverse();
    for (const version of versionDirs) {
      const candidate = path.join(resolvedKitsRoot, version, process.arch === 'arm64' ? 'arm64' : 'x64', 'signtool.exe');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // 无 Windows Kits → 退回 PATH。
  }
  return 'signtool';
}

/**
 * 对单个二进制执行 signtool 签名;失败抛错(签名已配置却失败 → 打包必须红,
 * 不得产出未签名的发布物)。调用方负责在 finally 里清理 material.tempDir。
 */
export function signBinary(material: SignMaterial, targetPath: string, env: NodeJS.ProcessEnv = process.env): void {
  const signtool = resolveSigntoolPath(env);
  if (!signtool) {
    throw new Error('未找到 signtool(可经 CODEMUX_SIGNTOOL_PATH 指定 Windows Kits 路径)');
  }
  try {
    execFileSync(signtool, buildSignArgs(material, targetPath), { stdio: 'inherit' });
  } catch (error) {
    throw new Error(`daemon 二进制签名失败(${targetPath}): ${String(error)}`);
  }
}

/** 清理 resolveSignMaterial 可能产生的临时目录。 */
export function cleanupSignMaterial(material: SignMaterial): void {
  if (material.tempDir) {
    try {
      rmSync(material.tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
