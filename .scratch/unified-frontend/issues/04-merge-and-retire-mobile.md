# 04 — 协议客户端合并与移动端独立构建退役

**What to build:** 移动端的配对存储、Connection Offer 编解码、中继/端到端加密、轮询回退逻辑并入统一协议客户端，两套 API/WS 客户端合并为一并带测试；统一产物替代移动端独立构建——daemon 静态目录切换、独立构建脚本与测试套件清理，仓库回到单前端终态。

**Blocked by:** 03 — 远程接入与响应式

**Status:** implemented（三形态人工验收待补）

- [x] 统一协议客户端为唯一实现，移动端专属逻辑（配对、Offer、中继/E2EE、轮询）内聚其中且有测试覆盖
- [x] daemon 静态目录指向统一产物，独立移动端构建路径、脚本与产物清理干净，无死构建链
- [ ] 全量测试（根、sidecar）与 `npm run dev:desktop`、浏览器、手机三形态人工验收通过

## Comments

**2026-09-13 实现说明**

- **客户端合并已在工单 02/03 前置完成**：配对存储（`src/lib/bootstrap/connection-storage.ts`）、Connection Offer 编解码、中继 + E2EE、轮询回退（`src/lib/companion-connection/**`、`daemon-client` 的 `polling` 分支）都在共享代码库且带测试；统一前端不自建第二套客户端。本工单只做删除与收敛。
- **删除独立移动端**：`src-mobile/`（39 个源文件 + 独立 Vite/Vitest/TS 配置）整体移除；`npm run build:mobile`、`test:mobile` 与 `scripts/copy-mobile-dist.mjs` 一并删除，`npm run dev` 不再在启动前拷贝移动端产物。工作区里该目录有一处未提交的本地阈值改动，随删除一并放弃（用户已确认删除）。
- **产物链路唯一化**：daemon 侧 `PathRoots::mobile_static_dir()` 及其 3 个测试删除，`resolve_static_dir` 返回 `Option<PathBuf>`——配置覆盖(目录需存在) → 打包资源 `dist-web` → 开发环境源码树 `dist-web`，没有产物就不再挂静态服务（API 照常工作，浏览器入口 404 而不是回退到旧构建）。`build_router` 因此改为条件挂 `fallback_service`。
- **死构建链清理**：`.gitignore` 去掉 `dist-mobile`；根 `.github/workflows/ci.yml` 两处 `Build mobile companion` 改为 `Build unified web bundle`（`npm run build:web`）；`paseo.json` 的 `build mobile` 改为 `build web`，顺带把失效的 `dev`（`npm run tauri dev`，Tauri 壳早已移除）改为 `npm run dev:desktop`；中继打包链路 `scripts/relay/pack-full-deploy.ps1` + `baota-install.sh` 从 `mobile-web/`（`src-mobile` 产物）改为 `web/`（`dist-web` 产物）。
- **文档同步**：`AGENTS.md`、`README.md`、`CONTRIBUTING.md` 移除 `src-mobile`/`build:mobile` 描述，改为「单一前端 + `dist-web`」；ADR 0008 的 Decision 7 补一条取代性 amendment（保留历史决策原文）。
- **验证**：`cargo fmt --all --check`、`cargo check --all-targets --all-features`、`cargo test --lib`（477 passed，较改动前少 3 个已删的 `mobile_static_dir` 测试、多 1 个新测试）通过，改动文件 clippy 无告警；根 `npx vitest run` 1431 passed / 3 failed（`McpSettings` 1 + `SkillsSettings` 2，改动前既有的失败，与本次无关）；sidecar 607 passed；`npm run build:web` 与 `npm run build:daemon` 成功。新增 `missing_web_build_keeps_api_alive_without_browser_entry` 覆盖「无 `dist-web` 时 API 可用、页面 404」；另用真实 daemon 进程冒烟：`/` 与 `/sessions/abc` 均 200 且返回统一前端入口页、带 `Cache-Control: no-store`，`/api/health` 200，`/assets/index-*.js` 200。
- **待人工验收**：PC 浏览器（`http://127.0.0.1:<port>`）与手机浏览器扫码三形态的端到端体验，本工单不写自动化断言。
- **遗留观察（不阻塞本工单）**：中继打包（`relay:pack-full`）现在向公网 VPS 分发的是完整统一前端产物（约 4 MB+ 的 chunk），不再是移动精简页。追求「一套产物」的必然结果，但手机经中继首次加载会明显变重，后续可评估按需分包或中继侧压缩；另外移动端原来的 `manifest.json` / `sw.js` 随 `src-mobile/` 删除，统一前端的 PWA 可安装性按 spec 属「后续单独评估」。
