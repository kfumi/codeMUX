// electron-builder afterPack 钩子:给 extraResources 的 daemon 二进制补签名。
//
// electron-builder 只签应用本体(检测到 CSC_LINK/CSC_KEY_PASSWORD 即自动签);
// extraResources 不在其签名范围内。本钩子在 win 打包、且配置了签名环境变量时,
// 调用 dist-electron/codesign.js(pack:win 先跑 tsc,产物已存在)对
// <appOutDir>/resources/daemon/codemux-daemon.exe 做 signtool 签名。
// 未配置 CSC_LINK → 跳过(本地出包不强制签名)。
//
// 环境变量:
//   CSC_LINK / WIN_CSC_LINK      .pfx 文件路径或 base64(与应用本体签名同源)
//   CSC_KEY_PASSWORD             证书密码
//   CODEMUX_SIGNTOOL_PATH        显式指定 signtool(默认自动找 Windows Kits)

const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const cscLink = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
  if (!cscLink) {
    console.info('[sign-daemon] CSC_LINK 未设置,跳过 daemon 二进制签名(发布前请配置签名链)');
    return;
  }
  const target = path.join(context.appOutDir, 'resources', 'daemon', 'codemux-daemon.exe');
  if (!fs.existsSync(target)) {
    throw new Error(`[sign-daemon] 找不到待签名 daemon: ${target}`);
  }
  const { resolveSignMaterial, signBinary, cleanupSignMaterial } = require('../dist-electron/codesign.js');
  const material = resolveSignMaterial(cscLink, process.env.CSC_KEY_PASSWORD || null);
  try {
    signBinary(material, target);
    console.info(`[sign-daemon] daemon 已签名: ${target}`);
  } finally {
    cleanupSignMaterial(material);
  }
};
