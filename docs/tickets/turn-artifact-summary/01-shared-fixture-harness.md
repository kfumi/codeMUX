# 01 — 共享 fixture 与双侧对照骨架

**What to build:** 建立一份仓库级的共享测试数据文件，成为产物汇总「期望行为」的唯一定义处，并让 sidecar 侧与 Daemon 侧各自的测试都从它读取。这一版只描述**两端当前已经一致**的行为，把工具识别、路径提取、一次调用的折算、轮次累积、行数语义逐条钉住。

纯前置改造：**不改变任何生产行为**。它的价值在于此后两个工单都有落地处——需要一致性保证的改动一律「先扩 fixture，再改实现」。

**Blocked by:** None — can start immediately

**Status:** done

- [x] 新建仓库级测试数据目录存放 fixture；两侧测试都能从仓库根确定性读到它，不依赖当前工作目录
      `test-data/turn-artifact-summary/cases.json`。Rust 从 `CARGO_MANIFEST_DIR` 逐级上溯，TS 从 `import.meta.url` 逐级上溯；两侧都断言用例数组非空，避免 fixture 读不到时「0 个用例全绿」。
- [x] fixture 分两部分：行数用例（名称、变更前文本、变更后文本、期望增、期望删）与事件序列用例（名称、cwd、wire 级事件序列、期望产物条目）
      `lineCases` 22 条 + `eventCases` 25 条。
- [x] 行数部分只收录两端**当前已经一致**的边界用例；当前存在分歧的尾随换行用例由工单 02 处理
- [x] 事件序列部分覆盖：读取类与终端类工具被排除；写入新文件（无快照）；写入已存在文件（有快照）；单次编辑（有快照，断言前后文本与增删行数）；批量编辑（无快照，走退化基线）；同文件多次修改只保留最后一次成功结果；失败的工具不计入
- [x] 两侧测试都断言 fixture 中的期望值，不各自写死期望数字
- [x] 两侧测试全绿；可用「改动前后生产行为逐字节相同」验收本工单未改行为
- [x] fixture 文件顶部用注释说明格式，以及「新增用例先于改实现、用例需同时考虑实时与原生会话同步两种形状」的使用约定

**验收记录**

- TS：`apps/sidecar/src/artifactFixture.test.ts` —— 每个用例一个 `it`，共 50 项（22 行数 + 25 事件 + 3 结构断言）。
- Rust：`crates/daemon/src/agent/turn_artifact_summary.rs` 的 `tests::shared_fixture` 模块，两项测试分别遍历 `lineCases` 与 `eventCases`。
- 两侧投影函数都只比「用户看得见的字段」（file / 增删行数 / 变更前后文本），刻意丢掉 `patch`：它在两侧的存在性本就不一致，且不是用户可见内容。
