// Runtime Pack 构建逻辑测试。
//
// 验证 Pack 组装、manifest 生成、关键文件校验、内容串包检测和元数据一致性。
// 使用临时目录夹具，不依赖真实 npm 安装或真实 SDK 包。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PROVIDER_SPECS,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  validateManifest,
  verifyKeyFiles,
  detectCrossContamination,
  stagePack,
  sha256Bytes,
  sha256File,
  collectRelativeFiles,
  targetString,
} from "./runtime-pack-builder.mjs";

/** 创建一个假的 node_modules 结构用于测试。 */
function createFakeNodeModules(baseDir, packages) {
  const nodeModulesDir = path.join(baseDir, "node_modules");
  mkdirSync(nodeModulesDir, { recursive: true });
  for (const [pkgName, files] of Object.entries(packages)) {
    const pkgDir = path.join(nodeModulesDir, pkgName);
    mkdirSync(pkgDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(pkgDir, relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
  return nodeModulesDir;
}

function createTempDir() {
  return mkdtempSync(path.join(tmpdir(), "codemux-pack-test-"));
}

describe("runtime-pack-builder", () => {
  describe("PROVIDER_SPECS", () => {
    it("defines specs for all three providers", () => {
      expect(PROVIDER_SPECS.claude_code).toBeDefined();
      expect(PROVIDER_SPECS.codex).toBeDefined();
      expect(PROVIDER_SPECS.opencode).toBeDefined();
    });

    it("claude_code has platform binary prefix for native binaries", () => {
      expect(PROVIDER_SPECS.claude_code.platformBinaryPrefix).toBe(
        "@anthropic-ai/claude-agent-sdk"
      );
      expect(PROVIDER_SPECS.claude_code.keyBinariesByTarget["windows-x64"]).toContain(
        "claude.exe"
      );
    });

    it("opencode has altSdkPackage for the CLI binary", () => {
      expect(PROVIDER_SPECS.opencode.altSdkPackage).toBe("opencode-ai");
      expect(PROVIDER_SPECS.opencode.keyBinariesByTarget["windows-x64"]).toContain(
        "bin/opencode.exe"
      );
    });

    it("codex has no platform binaries", () => {
      expect(PROVIDER_SPECS.codex.platformBinaryPrefix).toBeNull();
      expect(PROVIDER_SPECS.codex.keyBinariesByTarget["windows-x64"]).toHaveLength(0);
    });
  });

  describe("targetString", () => {
    it("joins platform and arch with dash", () => {
      expect(targetString("windows", "x64")).toBe("windows-x64");
      expect(targetString("macos", "arm64")).toBe("macos-arm64");
    });
  });

  describe("sha256Bytes / sha256File", () => {
    it("computes SHA-256 of bytes", () => {
      const hash = sha256Bytes(Buffer.from("hello"));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("computes SHA-256 of a file", async () => {
      const dir = createTempDir();
      const filePath = path.join(dir, "test.txt");
      writeFileSync(filePath, "hello");
      const hash = await sha256File(filePath);
      expect(hash).toBe(sha256Bytes(Buffer.from("hello")));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("collectRelativeFiles", () => {
    it("collects relative paths in posix format", async () => {
      const dir = createTempDir();
      mkdirSync(path.join(dir, "a", "b"), { recursive: true });
      writeFileSync(path.join(dir, "root.txt"), "1");
      writeFileSync(path.join(dir, "a", "file.txt"), "2");
      writeFileSync(path.join(dir, "a", "b", "deep.txt"), "3");
      const files = await collectRelativeFiles(dir);
      expect(files).toEqual(["a/b/deep.txt", "a/file.txt", "root.txt"]);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("stagePack", () => {
    let sourceDir;
    let stagingDir;

    beforeEach(() => {
      sourceDir = createTempDir();
      stagingDir = createTempDir();
    });

    afterEach(() => {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(stagingDir, { recursive: true, force: true });
    });

    it("stages claude_code SDK with platform binary and transitive deps", async () => {
      createFakeNodeModules(sourceDir, {
        "@anthropic-ai/claude-agent-sdk": {
          "package.json": JSON.stringify({
            name: "@anthropic-ai/claude-agent-sdk",
            version: "0.3.169",
            dependencies: { "@anthropic-ai/sdk": "^0.1.0" },
          }),
          "index.js": "module.exports = {};",
        },
        "@anthropic-ai/claude-agent-sdk-win32-x64": {
          "claude.exe": "fake-binary",
        },
        "@anthropic-ai/sdk": {
          "package.json": JSON.stringify({ name: "@anthropic-ai/sdk", version: "0.1.0" }),
          "index.js": "module.exports = {};",
        },
        "@openai/codex-sdk": {
          "package.json": JSON.stringify({ name: "@openai/codex-sdk" }),
        },
      });

      const result = await stagePack({
        provider: "claude_code",
        platform: "windows",
        arch: "x64",
        sourceNodeModules: path.join(sourceDir, "node_modules"),
        stagingDir,
      });

      // SDK 包被复制
      expect(existsSync(path.join(stagingDir, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"))).toBe(true);
      // 平台二进制包被复制（npm 使用 win32 而非 windows）
      expect(existsSync(path.join(stagingDir, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"))).toBe(true);
      // 传递依赖被复制
      expect(existsSync(path.join(stagingDir, "node_modules/@anthropic-ai/sdk/package.json"))).toBe(true);
      // 不应包含其他 Provider 的包
      expect(existsSync(path.join(stagingDir, "node_modules/@openai/codex-sdk"))).toBe(false);

      // keyFiles 指向 SDK 包的 package.json
      expect(result.keyFiles).toContain("@anthropic-ai/claude-agent-sdk/package.json");
      // keyBinaries 指向平台二进制（npm 平台名 win32-x64）
      expect(result.keyBinaries).toContain("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
    });

    it("stages opencode SDK with alt package and CLI binary", async () => {
      createFakeNodeModules(sourceDir, {
        "@opencode-ai/sdk": {
          "package.json": JSON.stringify({
            name: "@opencode-ai/sdk",
            version: "1.18.3",
            dependencies: {},
          }),
          "index.js": "module.exports = {};",
        },
        "opencode-ai": {
          "package.json": JSON.stringify({ name: "opencode-ai", version: "1.18.3" }),
          "bin/opencode.exe": "fake-cli",
          "bin/opencode.cmd": "@echo off",
        },
        "@anthropic-ai/claude-agent-sdk": {
          "package.json": JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk" }),
        },
      });

      const result = await stagePack({
        provider: "opencode",
        platform: "windows",
        arch: "x64",
        sourceNodeModules: path.join(sourceDir, "node_modules"),
        stagingDir,
      });

      expect(existsSync(path.join(stagingDir, "node_modules/@opencode-ai/sdk/package.json"))).toBe(true);
      expect(existsSync(path.join(stagingDir, "node_modules/opencode-ai/bin/opencode.exe"))).toBe(true);
      expect(existsSync(path.join(stagingDir, "node_modules/@anthropic-ai/claude-agent-sdk"))).toBe(false);

      expect(result.keyBinaries).toContain("opencode-ai/bin/opencode.exe");
      expect(result.keyBinaries).toContain("opencode-ai/bin/opencode.cmd");
    });

    it("stages codex SDK without platform binaries", async () => {
      createFakeNodeModules(sourceDir, {
        "@openai/codex-sdk": {
          "package.json": JSON.stringify({
            name: "@openai/codex-sdk",
            version: "0.139.0",
            dependencies: {},
          }),
          "index.js": "module.exports = {};",
        },
      });

      const result = await stagePack({
        provider: "codex",
        platform: "windows",
        arch: "x64",
        sourceNodeModules: path.join(sourceDir, "node_modules"),
        stagingDir,
      });

      expect(existsSync(path.join(stagingDir, "node_modules/@openai/codex-sdk/package.json"))).toBe(true);
      expect(result.keyBinaries).toHaveLength(0);
    });

    it("throws when SDK package is missing", async () => {
      createFakeNodeModules(sourceDir, {});
      await expect(
        stagePack({
          provider: "claude_code",
          platform: "windows",
          arch: "x64",
          sourceNodeModules: path.join(sourceDir, "node_modules"),
          stagingDir,
        })
      ).rejects.toThrow("SDK 包不存在");
    });

    it("throws for unknown provider", async () => {
      await expect(
        stagePack({
          provider: "unknown",
          platform: "windows",
          arch: "x64",
          sourceNodeModules: path.join(sourceDir, "node_modules"),
          stagingDir,
        })
      ).rejects.toThrow("未知 Provider");
    });
  });

  describe("verifyKeyFiles", () => {
    it("returns ok when all key files exist", () => {
      const dir = createTempDir();
      mkdirSync(path.join(dir, "pkg", "bin"), { recursive: true });
      writeFileSync(path.join(dir, "pkg/package.json"), "{}");
      writeFileSync(path.join(dir, "pkg/bin/claude.exe"), "fake");

      const result = verifyKeyFiles(dir, ["pkg/package.json"], ["pkg/bin/claude.exe"]);
      expect(result.ok).toBe(true);
      expect(result.missingFiles).toHaveLength(0);
      rmSync(dir, { recursive: true, force: true });
    });

    it("reports missing files and binaries", () => {
      const dir = createTempDir();
      mkdirSync(path.join(dir, "pkg"), { recursive: true });
      writeFileSync(path.join(dir, "pkg/package.json"), "{}");

      const result = verifyKeyFiles(
        dir,
        ["pkg/package.json", "pkg/missing.json"],
        ["pkg/bin/claude.exe"]
      );
      expect(result.ok).toBe(false);
      expect(result.missingFiles).toEqual(["pkg/missing.json"]);
      expect(result.missingBinaries).toEqual(["pkg/bin/claude.exe"]);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("buildManifest", () => {
    it("builds a manifest with all required fields", () => {
      const manifest = buildManifest({
        provider: "claude_code",
        version: "0.3.169",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://github.com/kfumi/codeMUX/releases/download/runtime-claude-0.3.169/claude-code-0.3.169-windows-x64.zip",
        sizeBytes: 1024000,
        sha256: "a".repeat(64),
        signature: "base64-signature",
        sidecarCompat: ">=0.2.0",
        keyFiles: ["@anthropic-ai/claude-agent-sdk/package.json"],
        keyBinaries: ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"],
      });

      expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
      expect(manifest.provider).toBe("claude_code");
      expect(manifest.version).toBe("0.3.169");
      expect(manifest.platform).toBe("windows");
      expect(manifest.arch).toBe("x64");
      expect(manifest.asset.url).toContain("claude");
      expect(manifest.asset.sizeBytes).toBe(1024000);
      expect(manifest.asset.sha256).toBe("a".repeat(64));
      expect(manifest.asset.signature).toBe("base64-signature");
      expect(manifest.sidecarCompat).toBe(">=0.2.0");
      expect(manifest.keyFiles).toHaveLength(1);
      expect(manifest.keyBinaries).toHaveLength(1);
      expect(manifest.createdAt).toBeTruthy();
    });
  });

  describe("validateManifest", () => {
    function validManifest() {
      return buildManifest({
        provider: "codex",
        version: "0.139.0",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://example.com/codex.zip",
        sizeBytes: 500,
        sha256: "b".repeat(64),
        signature: "sig",
        sidecarCompat: ">=0.2.0",
        keyFiles: ["@openai/codex-sdk/package.json"],
        keyBinaries: [],
      });
    }

    it("accepts a well-formed manifest", () => {
      const result = validateManifest(validManifest());
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects wrong schema version", () => {
      const m = validManifest();
      m.schemaVersion = 99;
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects unknown provider", () => {
      const m = validManifest();
      m.provider = "unknown_provider";
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects empty version", () => {
      const m = validManifest();
      m.version = "  ";
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects invalid SHA-256", () => {
      const m = validManifest();
      m.asset.sha256 = "short";
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects zero sizeBytes", () => {
      const m = validManifest();
      m.asset.sizeBytes = 0;
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects empty sidecarCompat", () => {
      const m = validManifest();
      m.sidecarCompat = "";
      expect(validateManifest(m).ok).toBe(false);
    });

    it("rejects empty keyFiles", () => {
      const m = validManifest();
      m.keyFiles = [];
      expect(validateManifest(m).ok).toBe(false);
    });
  });

  describe("detectCrossContamination", () => {
    it("passes when manifest only references its own provider packages", () => {
      const manifest = buildManifest({
        provider: "claude_code",
        version: "0.3.169",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://example.com/claude.zip",
        sizeBytes: 1000,
        sha256: "a".repeat(64),
        signature: "sig",
        sidecarCompat: ">=0.2.0",
        keyFiles: ["@anthropic-ai/claude-agent-sdk/package.json"],
        keyBinaries: ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"],
      });
      const result = detectCrossContamination(manifest);
      expect(result.ok).toBe(true);
      expect(result.contaminations).toHaveLength(0);
    });

    it("detects when claude_code manifest references codex package", () => {
      const manifest = buildManifest({
        provider: "claude_code",
        version: "0.3.169",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://example.com/claude.zip",
        sizeBytes: 1000,
        sha256: "a".repeat(64),
        signature: "sig",
        sidecarCompat: ">=0.2.0",
        keyFiles: ["@anthropic-ai/claude-agent-sdk/package.json"],
        keyBinaries: [
          "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
          "@openai/codex-sdk/bin/codex.exe",
        ],
      });
      const result = detectCrossContamination(manifest);
      expect(result.ok).toBe(false);
      expect(result.contaminations.length).toBeGreaterThan(0);
      expect(result.contaminations.some((c) => c.includes("@openai/codex-sdk"))).toBe(true);
    });

    it("detects when opencode manifest references claude package", () => {
      const manifest = buildManifest({
        provider: "opencode",
        version: "1.18.3",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://example.com/opencode.zip",
        sizeBytes: 1000,
        sha256: "c".repeat(64),
        signature: "sig",
        sidecarCompat: ">=0.2.0",
        keyFiles: [
          "@opencode-ai/sdk/package.json",
          "@anthropic-ai/claude-agent-sdk/package.json",
        ],
        keyBinaries: ["opencode-ai/bin/opencode.exe"],
      });
      const result = detectCrossContamination(manifest);
      expect(result.ok).toBe(false);
      expect(result.contaminations.some((c) => c.includes("@anthropic-ai/claude-agent-sdk"))).toBe(true);
    });

    it("passes for codex manifest with no key binaries", () => {
      const manifest = buildManifest({
        provider: "codex",
        version: "0.139.0",
        platform: "windows",
        arch: "x64",
        downloadUrl: "https://example.com/codex.zip",
        sizeBytes: 500,
        sha256: "b".repeat(64),
        signature: "sig",
        sidecarCompat: ">=0.2.0",
        keyFiles: ["@openai/codex-sdk/package.json"],
        keyBinaries: [],
      });
      const result = detectCrossContamination(manifest);
      expect(result.ok).toBe(true);
    });
  });
});
