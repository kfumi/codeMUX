// Runtime Pack 构建入口。
//
// 用法:
//   node scripts/build-runtime-pack.mjs <provider> <version> --platform <p> --arch <a>
//                                       [--source <sidecar-node-modules>]
//                                       [--output <dir>]
//                                       [--signing-key <pem-file>]
//                                       [--sidecar-compat <range>]
//                                       [--download-url-template <url>]
//
// 生成 <output>/<provider>-<version>-<platform>-<arch>.zip 和对应的 .manifest.json。
// 如果提供 --signing-key，会使用 ed25519 对 Pack zip 的 SHA-256 签名。

import { createHash, generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { zipSync } from "node:zlib";
import {
  PROVIDER_SPECS,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  detectCrossContamination,
  npmPlatformName,
  sha256File,
  stagePack,
  validateManifest,
  verifyKeyFiles,
} from "./lib/runtime-pack-builder.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { positional: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args.options[key] = "true";
      } else {
        args.options[key] = next;
        i++;
      }
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(1);
}

/**
 * 使用 ed25519 私钥对 SHA-256 哈希签名，返回 base64 签名。
 * 如果未提供私钥，返回占位签名（仅用于本地构建，不可用于正式发布）。
 */
function signSha256(sha256Hex, signingKeyPath) {
  if (!signingKeyPath) {
    return "unsigned-placeholder";
  }
  const keyPem = readFileSync(signingKeyPath, "utf8");
  const privateKey = createPrivateKey(keyPem);
  const signature = sign(null, Buffer.from(sha256Hex, "hex"), privateKey);
  return signature.toString("base64");
}

/**
 * 将暂存目录打包为 zip。
 * 使用 Node 内置的 zlib 不支持 zip 容器，这里使用简单的 tar.gz 替代。
 * 实际生产构建应使用 `tar` 或第三方 zip 库；此处为保持零依赖使用 tar.gz。
 */
async function createPackArchive(stagingDir, outputPath) {
  // 使用系统 tar 命令创建 .tar.gz，避免引入第三方依赖。
  const { execFileSync } = await import("node:child_process");
  const archivePath = outputPath.endsWith(".tar.gz")
    ? outputPath
    : `${outputPath}.tar.gz`;
  execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(stagingDir), path.basename(stagingDir)], {
    stdio: "inherit",
  });
  return archivePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [provider, version] = args.positional;

  if (!provider || !version) {
    console.error(
      "用法: node scripts/build-runtime-pack.mjs <provider> <version> --platform <p> --arch <a>"
    );
    process.exit(1);
  }

  const platform = args.options.platform || "windows";
  const arch = args.options.arch || "x64";
  const sourceNodeModules =
    args.options.source ||
    path.join(rootDir, "src-tauri", "sidecar", "node_modules");
  const outputDir = args.options.output || path.join(rootDir, "dist", "runtime-packs");
  const signingKeyPath = args.options["signing-key"] || null;
  const sidecarCompat = args.options["sidecar-compat"] || ">=0.2.0";
  const downloadUrlTemplate =
    args.options["download-url-template"] ||
    "https://github.com/kfumi/codeMUX/releases/download/runtime-{provider}-{version}/{provider}-{version}-{platform}-{arch}.tar.gz";

  if (!PROVIDER_SPECS[provider]) {
    fail(`未知 Provider: ${provider}（支持: claude_code, codex, opencode）`);
  }
  if (!existsSync(sourceNodeModules)) {
    fail(`sidecar node_modules 不存在: ${sourceNodeModules}（请先运行 npm ci）`);
  }

  console.log(`构建 ${provider} Runtime Pack v${version} (${platform}-${arch})`);

  // 1. 暂存 Pack 内容
  const stagingDir = mkdtempSync(path.join(tmpdir(), "codemux-pack-"));
  try {
    const { keyFiles, keyBinaries, copiedPackages } = await stagePack({
      provider,
      platform,
      arch,
      sourceNodeModules,
      stagingDir,
    });
    console.log(`已暂存 ${copiedPackages.length} 个包: ${copiedPackages.join(", ")}`);

    // 2. 校验关键文件和二进制
    const verification = verifyKeyFiles(stagingDir, keyFiles, keyBinaries);
    if (!verification.ok) {
      fail(
        `关键文件/二进制缺失: ${[...verification.missingFiles, ...verification.missingBinaries].join(", ")}`
      );
    }
    console.log("关键文件和二进制校验通过");

    // 3. 打包
    if (!existsSync(outputDir)) {
      await import("node:fs/promises").then((fs) => fs.mkdir(outputDir, { recursive: true }));
    }
    const archiveBaseName = `${provider}-${version}-${platform}-${arch}`;
    const archivePath = await createPackArchive(stagingDir, path.join(outputDir, archiveBaseName));

    // 4. 计算 SHA-256 和大小
    const sha256 = await sha256File(archivePath);
    const sizeBytes = statSync(archivePath).size;
    console.log(`Pack 大小: ${sizeBytes} 字节, SHA-256: ${sha256}`);

    // 5. 签名
    const signature = signSha256(sha256, signingKeyPath);
    if (signingKeyPath) {
      console.log("已使用 ed25519 私钥签名");
    } else {
      console.log("警告: 未提供签名密钥，manifest 签名为占位值（不可用于正式发布）");
    }

    // 6. 构建 manifest
    const downloadUrl = downloadUrlTemplate
      .replaceAll("{provider}", provider)
      .replaceAll("{version}", version)
      .replaceAll("{platform}", platform)
      .replaceAll("{arch}", arch);

    const manifest = buildManifest({
      provider,
      version,
      platform,
      arch,
      downloadUrl,
      sizeBytes,
      sha256,
      signature,
      sidecarCompat,
      keyFiles,
      keyBinaries,
    });

    // 7. 校验 manifest 自身
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.ok) {
      fail(`manifest 校验失败: ${manifestValidation.errors.join("; ")}`);
    }

    // 8. 串包检测
    const contamination = detectCrossContamination(manifest);
    if (!contamination.ok) {
      fail(`检测到 Provider 内容串包: ${contamination.contaminations.join("; ")}`);
    }

    // 9. 写入 manifest
    const manifestPath = path.join(outputDir, `${archiveBaseName}.manifest.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    console.log("");
    console.log("Runtime Pack 构建完成:");
    console.log(`  Pack:   ${archivePath}`);
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`  Provider: ${provider}`);
    console.log(`  Version:  ${version}`);
    console.log(`  Target:   ${platform}-${arch}`);
    console.log(`  SHA-256:  ${sha256}`);
    console.log(`  Signed:   ${signingKeyPath ? "yes" : "no (placeholder)"}`);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("构建失败:", err);
  process.exit(1);
});
