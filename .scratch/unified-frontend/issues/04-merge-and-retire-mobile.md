# 04 — 协议客户端合并与移动端独立构建退役

**What to build:** 移动端的配对存储、Connection Offer 编解码、中继/端到端加密、轮询回退逻辑并入统一协议客户端，两套 API/WS 客户端合并为一并带测试；统一产物替代移动端独立构建——daemon 静态目录切换、独立构建脚本与测试套件清理，仓库回到单前端终态。

**Blocked by:** 03 — 远程接入与响应式

**Status:** ready-for-agent

- [ ] 统一协议客户端为唯一实现，移动端专属逻辑（配对、Offer、中继/E2EE、轮询）内聚其中且有测试覆盖
- [ ] daemon 静态目录指向统一产物，独立移动端构建路径、脚本与产物清理干净，无死构建链
- [ ] 全量测试（根、sidecar）与 `npm run dev:desktop`、浏览器、手机三形态人工验收通过

## Comments

**2026-09-13 进展与阻塞**

- **客户端合并已在工单 02/03 前置完成**：配对存储（`src/lib/bootstrap/connection-storage.ts`）、Connection Offer 编解码、中继 + E2EE、轮询回退（`src/lib/companion-connection/**`、`daemon-client` 的 `polling` 分支）都在共享代码库且带测试；统一前端不再自建第二套客户端。daemon 静态目录解析已优先 `dist-web`，移动端产物只是兜底。
- **剩余的是删除动作**：`src-mobile/`（39 个源文件）+ `npm run build:mobile` + `dist-mobile` 链接清理。当前工作区里 `src-mobile/src/components/MobileComposer.tsx` 有**未提交的用户改动**（与 `ContextProgress.tsx` 同批的阈值调整），删除会一并丢弃，因此本工单的删除步骤需要用户确认后再执行（可先 cherry-pick 该改动到统一前端或明确放弃）。
