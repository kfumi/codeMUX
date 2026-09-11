// 签名链助手契约(工单 09 验收:签名链覆盖 daemon 二进制):CSC_LINK 归一化、
// signtool 参数形状、signtool 定位。真实 signtool 调用不在单测范围(打包机行为)。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSignArgs, resolveSignMaterial, resolveSigntoolPath } from '../src/codesign';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codemux-codesign-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveSignMaterial', () => {
  it('文件路径形态直接透传,不产生临时目录', () => {
    const dir = makeTempDir();
    const pfx = path.join(dir, 'cert.pfx');
    writeFileSync(pfx, 'fake', 'utf8');
    const material = resolveSignMaterial(pfx, 'secret');
    expect(material.pfxPath).toBe(pfx);
    expect(material.password).toBe('secret');
    expect(material.tempDir).toBeNull();
  });

  it('base64 与 data: URI 解码为临时 pfx', () => {
    // 至少 512 字符的 base64 才按裸 base64 识别。
    const raw = Buffer.alloc(600, 7).toString('base64');
    const asBase64 = resolveSignMaterial(raw, null);
    expect(asBase64.password).toBeNull();
    expect(existsSync(asBase64.pfxPath)).toBe(true);

    const asDataUri = resolveSignMaterial(`data:application/x-pkcs12;base64,${raw}`, 'pw');
    expect(asDataUri.password).toBe('pw');
    expect(existsSync(asDataUri.pfxPath)).toBe(true);
  });

  it('不存在的文件路径抛错', () => {
    expect(() => resolveSignMaterial('Z:/no/such/cert.pfx', null)).toThrow('证书文件不存在');
  });
});

describe('buildSignArgs', () => {
  it('SHA256 摘要 + RFC3161 时间戳 + 证书与目标', () => {
    const args = buildSignArgs({ pfxPath: 'C:/c.pfx', password: 'pw', tempDir: null }, 'D:/daemon.exe');
    expect(args).toEqual([
      '/sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256',
      '/p', 'pw', '/f', 'C:/c.pfx', 'D:/daemon.exe',
    ]);
  });

  it('无密码时省略 /p', () => {
    const args = buildSignArgs({ pfxPath: 'C:/c.pfx', password: null, tempDir: null }, 'D:/daemon.exe');
    expect(args).toEqual([
      '/sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256',
      '/f', 'C:/c.pfx', 'D:/daemon.exe',
    ]);
  });
});

describe('resolveSigntoolPath', () => {
  it('CODEMUX_SIGNTOOL_PATH 存在则优先;指向不存在路径返回 null', () => {
    expect(resolveSigntoolPath({ CODEMUX_SIGNTOOL_PATH: process.execPath })).toBe(process.execPath);
    expect(resolveSigntoolPath({ CODEMUX_SIGNTOOL_PATH: 'Z:/no/signtool.exe' })).toBeNull();
  });

  it('无显式路径且 Windows Kits 目录不存在时回退 PATH 上的 signtool', () => {
    expect(resolveSigntoolPath({}, 'Z:/no/windows-kits/bin')).toBe('signtool');
  });

  it('Windows Kits 多版本目录取最高版本的 x64 signtool', () => {
    const kits = makeTempDir();
    for (const version of ['10.0.19041.0', '10.0.22621.0']) {
      const dir = path.join(kits, version, 'x64');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'signtool.exe'), 'fake', 'utf8');
    }
    expect(resolveSigntoolPath({}, kits)).toBe(path.join(kits, '10.0.22621.0', 'x64', 'signtool.exe'));
  });
});
