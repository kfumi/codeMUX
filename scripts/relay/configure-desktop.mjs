#!/usr/bin/env node
/**
 * 写入 CodeMUX 桌面端 companion.relay 端点（不自动启用，需 VPS 部署完成后再开）。
 *
 * Usage: node scripts/relay/configure-desktop.mjs [host:port] [--tls|--no-tls]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ENDPOINT = 'relay.fumi-blog.top:443';
const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const useTls = !process.argv.includes('--no-tls');
const endpoint = cliArgs[0] ?? DEFAULT_ENDPOINT;

const appData = process.env.APPDATA;
if (!appData) {
  console.error('APPDATA 未设置，无法定位 CodeMUX 配置目录');
  process.exit(1);
}

const configPath = join(appData, 'com.codemux.desktop', 'config.json');
let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`无法读取 ${configPath}:`, error);
  process.exit(1);
}

const backupPath = `${configPath}.bak-relay`;
copyFileSync(configPath, backupPath);

config.companion ??= {};
config.companion.relay ??= {};
config.companion.relay.endpoint = endpoint;
config.companion.relay.use_tls = useTls;
// 保持 enabled 不变；若仍是 localhost 遗留且未启用，确保不误开
if (config.companion.relay.enabled === undefined) {
  config.companion.relay.enabled = false;
}

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`已备份: ${backupPath}`);
console.log(`已写入 companion.relay:`);
console.log(`  endpoint: ${config.companion.relay.endpoint}`);
console.log(`  use_tls: ${config.companion.relay.use_tls}`);
console.log(`  enabled: ${config.companion.relay.enabled}`);
console.log('');
console.log('下一步: 在 VPS 部署中继并添加 DNS 后，于 CodeMUX 移动伴侣中点击「启用中继」。');
