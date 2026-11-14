// electron-builder afterPack 钩子入口:先校验随包 Node 运行时,再给 daemon 补签名。
//
// electron-builder 的 `afterPack` 只能挂一个入口,所以用这个文件做组合,
// 避免两个职责互相覆盖。
const signDaemon = require('./sign-daemon.cjs');
const verifyNodeRuntime = require('./verify-node-runtime.cjs');

module.exports = async function afterPack(context) {
  await verifyNodeRuntime(context);
  await signDaemon(context);
};
