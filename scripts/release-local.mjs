import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true";
const skipBuild = process.argv.includes("--skip-build") || process.env.npm_config_skip_build === "true";

if (!versionArg) {
  console.error("用法: npm run release:local -- <版本号> [--dry-run] [--skip-build]");
  process.exit(1);
}

const version = versionArg.replace(/^v/, "");

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`版本号格式无效: ${versionArg}，应为 x.y.z 或 vx.y.z`);
  process.exit(1);
}

const releaseTag = `v${version}`;
const tauriDir = path.join(rootDir, "src-tauri");
const bundleDir = path.join(tauriDir, "target", "release", "bundle");
const outDir = path.join(rootDir, "out", "manual-release", releaseTag);
const assetsDir = path.join(outDir, "assets");
const updaterKeyPath = path.join(process.env.USERPROFILE ?? "", ".tauri", "codemux-updater.key");
const updaterPasswordPath = path.join(
  process.env.USERPROFILE ?? "",
  ".tauri",
  "codemux-updater-password.txt",
);
const publicRepoOwner = "kfumi";
const publicRepoName = "codeMUX-desktop";

function resolveCommand(command) {
  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    return `${command}.cmd`;
  }

  return command;
}

function run(command, args, options = {}) {
  const resolvedCommand = resolveCommand(command);

  if (dryRun) {
    console.log(`[dry-run] ${resolvedCommand} ${args.join(" ")}`);
    return "";
  }

  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", [
      "/d",
      "/s",
      "/c",
      `${resolvedCommand} ${args.join(" ")}`,
    ], {
      cwd: options.cwd ?? rootDir,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      encoding: options.capture ? "utf8" : undefined,
      env: options.env ?? process.env,
    });
  }

  return execFileSync(resolvedCommand, args, {
    cwd: options.cwd ?? rootDir,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
  });
}

function ensureFileExists(filePath, label) {
  if (!existsSync(filePath)) {
    console.error(`缺少${label}：${filePath}`);
    process.exit(1);
  }
}

function findVersionedFiles(dirPath, matcher) {
  if (!existsSync(dirPath)) {
    return [];
  }

  return readdirSync(dirPath)
    .filter((name) => matcher(name))
    .map((name) => path.join(dirPath, name));
}

function releaseDownloadUrl(fileName) {
  return `https://github.com/${publicRepoOwner}/${publicRepoName}/releases/download/${releaseTag}/${fileName}`;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relativeToRoot(filePath) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}

const platform = process.platform;
if (platform !== "win32") {
  console.error("本地一键手动发版脚本当前仅支持在 Windows 上执行。");
  process.exit(1);
}

ensureFileExists(updaterKeyPath, "updater 私钥");
ensureFileExists(updaterPasswordPath, "updater 私钥密码文件");

const updaterPrivateKey = readFileSync(updaterKeyPath, "utf8");
const updaterPrivateKeyPassword = readFileSync(updaterPasswordPath, "utf8").trim();

const prepareArgs = [path.join(rootDir, "scripts", "prepare-release.mjs"), version];
if (dryRun) {
  prepareArgs.push("--dry-run");
}
run("node", prepareArgs);

if (!skipBuild) {
  run("npm", ["run", "build"]);
  run("npm", ["run", "build"], { cwd: path.join(tauriDir, "sidecar") });
  run("npx", ["tauri", "build"], {
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: updaterPrivateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterPrivateKeyPassword,
    },
  });
}

const msiFiles = findVersionedFiles(path.join(bundleDir, "msi"), (name) =>
  name.includes(`_${version}_`) && !name.endsWith(".sig")
);
const msiSigFiles = findVersionedFiles(path.join(bundleDir, "msi"), (name) =>
  name.includes(`_${version}_`) && name.endsWith(".sig")
);
const nsisFiles = findVersionedFiles(path.join(bundleDir, "nsis"), (name) =>
  name.includes(`_${version}_`) && !name.endsWith(".sig")
);
const nsisSigFiles = findVersionedFiles(path.join(bundleDir, "nsis"), (name) =>
  name.includes(`_${version}_`) && name.endsWith(".sig")
);

if (dryRun && (msiFiles.length === 0 || nsisFiles.length === 0)) {
  console.log("当前为 dry-run，未要求本地必须已有安装包产物，跳过文件整理阶段检查。");
  console.log(`预期输出目录：${relativeToRoot(outDir)}`);
  console.log("正式执行时会整理以下文件类型：");
  console.log("- assets/*.msi");
  console.log("- assets/*.msi.sig");
  console.log("- assets/*-setup.exe");
  console.log("- assets/*-setup.exe.sig");
  console.log("- assets/latest.json");
  console.log("- 上传清单.md");
  console.log("- Release 文案.md");
  process.exit(0);
}

if (msiFiles.length === 0 || nsisFiles.length === 0) {
  console.error("未找到当前版本的 Windows 安装包产物，请先检查本地构建是否成功。");
  process.exit(1);
}

const preferredUpdaterArtifact = nsisFiles[0];
const preferredUpdaterSignature = nsisSigFiles.find((file) =>
  path.basename(file).startsWith(path.basename(preferredUpdaterArtifact))
);

if (!preferredUpdaterSignature) {
  console.error("未找到 NSIS 安装包对应的签名文件，无法生成 latest.json。");
  process.exit(1);
}

const preferredSignatureContent = readFileSync(preferredUpdaterSignature, "utf8").trim();
const nowIso = new Date().toISOString();

const latestJson = {
  version,
  notes: `CodeMUX ${version} 版本更新，请在发布前补充本次更新说明。`,
  pub_date: nowIso,
  platforms: {
    "windows-x86_64": {
      signature: preferredSignatureContent,
      url: releaseDownloadUrl(path.basename(preferredUpdaterArtifact)),
    },
  },
};

const collectedAssets = [
  ...msiFiles,
  ...msiSigFiles,
  ...nsisFiles,
  ...nsisSigFiles,
];

if (!dryRun) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });

  for (const asset of collectedAssets) {
    copyFileSync(asset, path.join(assetsDir, path.basename(asset)));
  }

  writeJson(path.join(assetsDir, "latest.json"), latestJson);

  const releaseMeta = {
    version,
    tag: releaseTag,
    generatedAt: nowIso,
    publicReleaseRepo: `${publicRepoOwner}/${publicRepoName}`,
    updaterArtifact: path.basename(preferredUpdaterArtifact),
    copiedAssets: collectedAssets.map((file) => path.basename(file)),
  };

  writeJson(path.join(outDir, "release-meta.json"), releaseMeta);

  const uploadChecklist = `# CodeMUX 本地手动发版清单

## 版本信息

- 版本号：${version}
- 标签：${releaseTag}
- 生成时间：${nowIso}
- 发布仓库：${publicRepoOwner}/${publicRepoName}

## 需要上传的文件

以下文件已整理到 \`assets/\` 目录：

${[...collectedAssets.map((file) => `- ${path.basename(file)}`), "- latest.json"].join("\n")}

## 手动发布步骤

1. 打开公开下载仓库的 Releases 页面：
   - https://github.com/${publicRepoOwner}/${publicRepoName}/releases
2. 新建一个 Release，标签填写：
   - ${releaseTag}
3. Release 标题填写：
   - codeMUX ${releaseTag}
4. 将 \`assets/\` 目录下的全部文件拖拽上传
5. 发布完成后，确认 \`latest.json\` 也已上传成功

## 说明

- \`latest.json\` 已按当前 Windows NSIS 安装包自动生成，用于 Tauri updater 检查更新
- 当前本地手动发版只整理 Windows 产物，不包含 macOS 和 Linux
- 如果你后续重新本地构建同版本，请重新执行一次脚本，覆盖这份目录
`;

  writeFileSync(path.join(outDir, "上传清单.md"), uploadChecklist, "utf8");

  const releaseBody = `## 下载说明

- Windows 安装包请下载：
  - ${path.basename(nsisFiles[0])}
  - ${path.basename(msiFiles[0])}

## 更新说明

请在这里补充 ${releaseTag} 的更新内容。
`;

  writeFileSync(path.join(outDir, "Release 文案.md"), releaseBody, "utf8");
}

console.log(`已完成本地手动发版准备：${releaseTag}`);
console.log(`输出目录：${relativeToRoot(outDir)}`);
console.log("已整理文件：");
for (const asset of collectedAssets) {
  console.log(`- assets/${path.basename(asset)}`);
}
console.log("- assets/latest.json");
console.log("- 上传清单.md");
console.log("- Release 文案.md");

if (dryRun) {
  console.log("当前为 dry-run，仅执行了命令预演，没有复制文件。");
} else {
  console.log("下一步只需要手动去 GitHub Releases 上传 out/manual-release 下整理好的文件。");
}
