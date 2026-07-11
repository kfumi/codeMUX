import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const versionArg = process.argv[2];
const createTag = process.argv.includes("--tag");
const dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true";

if (!versionArg) {
  console.error("用法: npm run release:prepare -- <版本号> [--tag]");
  process.exit(1);
}

const normalizedVersion = versionArg.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) {
  console.error(`版本号格式无效: ${versionArg}，应为 x.y.z 或 vx.y.z`);
  process.exit(1);
}

const packageJsonPath = path.join(rootDir, "package.json");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(rootDir, "src-tauri", "Cargo.lock");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = normalizedVersion;

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = normalizedVersion;

const cargoToml = readFileSync(cargoTomlPath, "utf8");
const updatedCargoToml = cargoToml.replace(
  /^(\s*version\s*=\s*)".*"$/m,
  `$1"${normalizedVersion}"`
);
writeFileSync(cargoTomlPath, updatedCargoToml, "utf8");

const cargoLock = readFileSync(cargoLockPath, "utf8");
const updatedCargoLock = cargoLock.replace(
  /(\[\[package\]\]\r?\nname = "codemux"\r?\nversion = )".*"$/m,
  `$1"${normalizedVersion}"`
);

if (!dryRun) {
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, "utf8");
  writeFileSync(cargoTomlPath, updatedCargoToml, "utf8");
  writeFileSync(cargoLockPath, updatedCargoLock, "utf8");
}

if (createTag) {
  const tagName = `v${normalizedVersion}`;
  if (dryRun) {
    console.log(`[dry-run] git tag ${tagName}`);
  } else {
    execFileSync("git", ["tag", tagName], {
      cwd: rootDir,
      stdio: "inherit",
    });
    console.log(`已创建 Git tag: ${tagName}`);
  }
}

console.log(`已同步版本号为 ${normalizedVersion}`);
console.log("已更新文件:");
console.log("- package.json");
console.log("- src-tauri/tauri.conf.json");
console.log("- src-tauri/Cargo.toml");
console.log("- src-tauri/Cargo.lock");
if (dryRun) {
  console.log("当前为 dry-run，仅预演版本同步，没有写入文件。");
}
console.log("后续步骤:");
console.log("1. 提交版本变更");
console.log(`2. 推送代码与标签: git push origin master && git push origin v${normalizedVersion}`);
