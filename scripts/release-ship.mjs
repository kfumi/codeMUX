import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const versionArg = process.argv[2];
const dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true";

if (!versionArg) {
  console.error("用法: npm run release:ship -- <版本号> [--dry-run]");
  process.exit(1);
}

const normalizedVersion = versionArg.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) {
  console.error(`版本号格式无效: ${versionArg}，应为 x.y.z 或 vx.y.z`);
  process.exit(1);
}

function run(command, args, options = {}) {
  if (dryRun) {
    console.log(`[dry-run] ${command} ${args.join(" ")}`);
    return "";
  }

  return execFileSync(command, args, {
    cwd: rootDir,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
}

const statusBefore = execFileSync("git", ["status", "--porcelain"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();

if (statusBefore) {
  console.error("工作区不干净，请先提交或清理现有改动后再执行一键发版。");
  process.exit(1);
}

const currentBranch = execFileSync("git", ["branch", "--show-current"], {
  cwd: rootDir,
  encoding: "utf8",
}).trim();

if (currentBranch !== "master") {
  console.error(`当前分支为 ${currentBranch}，请切换到 master 后再执行一键发版。`);
  process.exit(1);
}

const tagName = `v${normalizedVersion}`;

if (!dryRun) {
  const existingTag = execFileSync("git", ["tag", "--list", tagName], {
    cwd: rootDir,
    encoding: "utf8",
  }).trim();

  if (existingTag) {
    console.error(`Git tag ${tagName} 已存在，请更换版本号后重试。`);
    process.exit(1);
  }
}

const prepareArgs = [path.join(rootDir, "scripts", "prepare-release.mjs"), normalizedVersion];
if (dryRun) {
  prepareArgs.push("--dry-run");
}

run("node", prepareArgs);
run("git", [
  "add",
  "package.json",
  "apps/desktop/package.json",
  "crates/daemon/Cargo.toml",
  "crates/daemon/Cargo.lock",
]);
run("git", ["commit", "-m", `chore(release): 发布 ${tagName}`]);
run("git", ["tag", tagName]);
run("git", ["push", "origin", "master"]);
run("git", ["push", "origin", tagName]);

console.log(`已完成一键发版流程：${tagName}`);
if (dryRun) {
  console.log("当前为 dry-run，仅输出了将执行的命令，没有改动文件、提交或推送。");
} else {
  console.log("Release workflow 已接管出包:tag 推送后 build-windows 会自动构建 NSIS 安装包");
  console.log("并上传到 GitHub Releases,无需本地出包。");
  console.log("注意:仓库 Secrets 未配置 CSC_LINK 时出的是未签名包;");
  console.log("详见 docs/guides/desktop-release-guide.md。");
}
