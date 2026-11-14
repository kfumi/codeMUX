// electron-builder afterPack 钩子:校验随包 Node 运行时是完整的。
//
// 为什么要校验:electron-builder 的 extraResources 会无条件丢弃根级
// `node_modules`(app-builder-lib/out/util/filter.js 的 createFilter:
// `relative === "node_modules"` 直接返回 false)。Windows 官方 Node 发行包把
// npm 本体放在 `node-runtime/node_modules/npm/`,于是 `from: node-runtime →
// to: node` 只会落下 node.exe 和 npm.cmd,npm.cmd 找不到 `npm-cli.js`。
// 这个缺失在打包时完全静默,直到用户打开设置页才暴露成「Node.js 运行时不可用」。
//
// 这里在打包完成后、生成安装包之前检查真正落盘的资源根,缺 npm 就让打包失败。
// 配置侧的修复见 electron-builder.yml 的 `win.extraResources`。

const fs = require('node:fs');
const path = require('node:path');

/** 资源根:win/linux 是 `<appOutDir>/resources`,mac 在 `.app/Contents/Resources`。 */
function resolveResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const productFilename = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

/** 官方 Node 发行包在 Windows 与 unix 上的布局。 */
function nodeRuntimeLayout(platform) {
  return platform === 'win32'
    ? {
        nodeBinary: 'node.exe',
        npmCli: path.join('node_modules', 'npm', 'bin', 'npm-cli.js'),
      }
    : {
        nodeBinary: path.join('bin', 'node'),
        npmCli: path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      };
}

module.exports = async function verifyNodeRuntime(context) {
  const platform = context.electronPlatformName;
  const nodeDir = path.join(resolveResourcesDir(context), 'node');
  const layout = nodeRuntimeLayout(platform);
  const nodeBinary = path.join(nodeDir, layout.nodeBinary);
  const npmCli = path.join(nodeDir, layout.npmCli);

  const missing = [nodeBinary, npmCli].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      '[verify-node-runtime] 随包 Node 运行时不完整,托管 Runtime 将无法安装:\n' +
        missing.map((file) => `  缺失: ${file}`).join('\n') +
        '\n检查 apps/desktop/electron-builder.yml 的 extraResources 配置，确保完整 ' +
        'Node 与 npm 文件已复制到资源根的 node/ 目录。',
    );
  }
  console.info(`[verify-node-runtime] 随包 Node 运行时完整: ${nodeDir}`);
};
