# 流式性能第四轮：按 Paseo 五道边界实施修复

- 日期：2026-09-16
- 依据：`2026-09-16-paseo-stream-smoothness-analysis.md`（对照分析）、`2026-09-16-realtime-chat-jank-root-cause.md`（根因清单）
- 范围：按对照文档的优先级，逐条实施；对**证据不足**的建议明确不做并说明原因
- 结论：实施 7 项修复，覆盖"体积 / 重渲染范围 / 绘制节奏 / 提交成本 / 持久化阻塞"五处；**明确否决 2 项**（依据是第三轮实测数据）

---

## 一、修了什么

| # | 修复 | 对应边界 / 根因 | 文件 |
|---|---|---|---|
| 1 | 工具输出体积上限 64KiB（唯一线缆出口截断） | 边界 2（体积）· 根因 14 | `sidecar/src/boundEventVolume.ts`（新增）、`streamEventBatcher.ts` |
| 2 | 历史身份稳定：按 id 复用未变化的投影消息与部件 | 边界 3/5（重渲染范围）· 根因 9/18 | `assistant-ui/assistantMessageIdentity.ts`（新增）、`CodeMuxAssistantRuntime.tsx` |
| 3 | 分帧绘制（paced reveal） | 边界 5（绘制节奏） | `assistant-ui/streamTextReveal.ts`（纯函数）、`useStreamingTextReveal.ts`（hook）、`CodeMuxThread.tsx` |
| 4 | 平滑度度量（CV + p95 + 推进帧占比） | 度量能力 | `lib/streamSmoothness.ts`（新增）、`dev/PerfOverlay.tsx` |
| 5 | 种子化 bursty 突流源（可复现） | 度量能力 | `lib/dev/burstyStreamSchedule.ts`（新增） |
| 6 | 持久化移出 tokio worker + 单行只解析一次 | 根因 7/11 | `agent/session_lifecycle.rs`、`timeline_persist.rs`、`subagent_persist.rs` |
| 7 | 消除空 `set({})`；scheduled 全量重拉节流 | 根因 8/13 | `stores/agentStore.ts` |
| 8 | `adapters` 字面量提为稳定引用 | 根因 9 | `CodeMuxAssistantRuntime.tsx` |

---

## 二、逐项说明

### 2.1 工具输出体积上限（单项收益最大）

**问题**：全仓原本**没有任何** agent 工具输出上限。Read 一个文件就把整份文件内容塞进
`tool_finished.content`，一路流过 IPC → SQLite → WS → 客户端 `structuredClone`。这与
第三轮实测"最长长任务稳定在 94–105ms"量级吻合。

**截断点选在 sidecar 唯一的 stdout 出口**（`streamEventBatcher.ts` 的 `writeJsonLine`）。
探查确认全仓源码只有这一个 stdout 写点（其余都在测试假进程里）。放在这里有一个结构性好处：
**daemon 收到的就已经是截断后的 JSON，因此"落库副本"与"广播副本"必然同源，不可能出现
Paseo 文档警告的"库里是截断的、WS 发的是全量"这种分裂**。同时省掉了 IPC 与多次 serde
解析的体积成本。

上限：工具输出 64 KiB（与 Paseo 对齐）、工具入参 256 KiB、流式入参增量 64 KiB。
截断会在内容尾部追加可见提示并附 `content_truncated` / `content_full_chars` 标记。

**刻意不截断的字段（重要，且是本次调研纠正了一个初期判断）**：

- `file_snapshot.original_content` —— 初判认为它"只是展示数据，可截断"，探查后确认
  **daemon 侧 `turn_artifact_summary.rs:96` 用它计算增删行统计**，截断会让统计失真。
  保留原样，改为从其它途径降低其成本（见 2.6 的异步读取说明与解析去重）。
- `assistant_message.content` / `user_message.content` —— 模型回答与用户提问的**本体**，
  是权威内容，不属于"工具输出"。

**剪裁安全性**：按 UTF-16 码元回溯，不会把代理对、组合标记、ZWJ 序列、变体选择符或
肤色修饰符从中间切开（`clipAtSafeBoundary`）。

### 2.2 历史身份稳定

**问题**：`convertAgentEventsToAssistantMessages` 每次都重建**全部**消息对象，而下游
assistant-ui 的转换缓存是 `WeakMap<外部消息对象, ThreadMessage>` —— 键每次都是新的，
**缓存 100% miss**，整条线程被反复重新转换、重新渲染。

**做法**：不重写那个带 splice / merge / 回溯附加语义的 fold（风险高），而在**出口**做一次
引用协调：把本次结果与上次结果按 `id` 对齐，**结构等价的消息与部件直接复用上次的对象引用**。

- 等价判定是"引用优先"的：引用相同即 O(1) 返回。本项目里 `data-codemux-event` 的
  `event` 由既有 `cloneEventOnce` 的 WeakMap 提供，同一源事件跨转换得到**同一个**克隆
  对象 → 引用命中；`tool-call.args` 里的大字符串（Write 的整份文件内容）同样来自稳定的
  事件对象 → 叶子层引用命中。
- 按 `id` 而非下标匹配：fold 会向中间 `splice` 消息、也会把消息合并进前一条。
- **为什么"比较最终状态"是安全的**：fold 确实会原地改写先前产出的消息（工具结果回填、
  会话摘要挂到尾部、最终消息标记），但那些改写只作用于**本次运行自己产出的**对象；上一次
  的产出在它的那次运行结束后就不再被触碰。因此"这次的最终结果"与"上次的最终结果"结构
  相等 ⇒ 内容完全相同 ⇒ 复用上次的对象是等价且正确的。
- 判定失败（含超深度）一律退回新对象 —— 退化为改动前的行为，不会引入错误。

同时把 `useExternalStoreRuntime` 的 `adapters` 字面量提为稳定引用：该库内部用
`if (this._store === store) return` 做守卫，且 `setAdapter` 的 effect 没有依赖数组，
每次渲染新建字面量会让守卫永不生效、adapter 每次渲染都被重灌。

### 2.3 分帧绘制（用户抱怨的那个"一顿一顿"）

**问题**：CodeMUX 原本只有 50ms 窗口的**速率上限**，没有**均匀化**。批次大小在一个回合内
可能相差一个数量级，而批次直接上屏 —— 这就是"一顿一顿"的直接来源。

**关键认知修正**（沿用对照文档的结论）：非 Claude 的 leading-edge 双触发不是"批次太多"，
而是"批次不均匀"。**减少批次数不会改善观感，反而加重不均匀。** 正解是保持速率、让它均匀落地。

**做法**：到达只决定**目标**，释放速率由 **backlog 推导** ——
`step = ceil(backlog × elapsed / horizonMs)`，下限 1 字符，horizon 150ms，单帧 elapsed
上限 250ms（帧被长任务阻塞后不会在一帧内倾泻）。突发只会让文字**追赶得更快**，不会**跳**。

不变量全部落实：

1. **首次见到一段文本整段渲染** —— 历史补全、时间线回放、虚拟化行重挂载都无需特例；
2. **离开 streaming 立即补全** —— 已完成的回合绝不残留半截文字；
3. **按时长归一**（而非按字符数）；
4. **剪裁点对齐字素簇**；
5. **store 存全文，只有渲染切片被节流** —— 复制/选中/滚动几何与屏幕一致。

策略层是**纯函数**、与 rAF 时钟分离（照 Paseo 的切分），因此可脱离渲染器测试。

**一处刻意的实现偏离**：字素簇边界用逐码元回溯而非 `Intl.Segmenter`。Segmenter 需要
O(全文) 分词，而这个判定**每帧都要跑**；逐码元回溯是 O(1)，覆盖代理对、组合标记、
ZWJ 序列、变体选择符与肤色修饰符 —— 实际会遇到的类目。已在代码注释中记录理由。

**A/B 开关**：`localStorage['codemux:textRevealHorizonMs'] = '0'` 即关闭节流（到达即绘制），
复刻 Paseo 用"horizon 设为 0"作对照列的做法。

### 2.4 平滑度度量

既有浮层只有 FPS / 内存 / IPC 速率 / 长任务 —— 都刻画不出"手感"。Paseo 的对照实测给出
反例：关闭分帧绘制时**总字符数完全相同**，但可见更新间隔 p95 从 17ms 恶化到 383ms。

新增两行读数：`流式平滑度`（字符/帧变异系数 + **推进帧占比**）与 `更新间隔 p50/p95`。
**推进帧占比必须一起看** —— 官方原话是"一个完全停顿的流是完美平滑的"，只报变异系数会把
卡死判成满分。

**为什么不用 DOM 采样**：Paseo 从 DOM 累加所有 `assistant-message` 元素总长度（并记录了
"只采尾部会把消息交接读成重置"的坑）。本项目渲染层没有等价的稳定公共选择器，因此改为
**在分帧绘制出口直接计数**：每一帧实际释放多少字符，由绘制层自己上报。这比 DOM 采样更精确
（不受 memo、虚拟化、交接影响）；代价是它只覆盖流式气泡本身，不含"内容块提交时整段出现"
的那一次跳变 —— 后者是消息边界的一次性事件，不属于连续流式的手感范畴。这个取舍已写在模块头注释里。

### 2.5 种子化 bursty 突流源

mulberry32 种子 PRNG → 确定的 `{ atMs, text }` 序列。批次大小用三次方偏置而非均匀分布
（均匀分布的"不均匀度"不足以复现真实拥堵：同量程下 CV≈0.57，三次方偏置下 CV>0.9，
已由测试断言）。`pumpBurstySchedule` 用单个自纠偏定时器驱动，避免上千个定时器把被测对象淹没。

### 2.6 持久化不再阻塞 tokio worker，且单行只解析一次

**问题**：`handle_sidecar_timeline_event` 与 `handle_sidecar_subagent_event` 都在 **async
上下文内持 `std::sync::Mutex` 同步写 SQLite**，且同一行 JSON 被 `serde_json::from_str`
解析 3 次、候选事件再 `clone()` 3 次。一次大事件落库期间，该会话后续所有 delta 广播都被堵在
同一个任务里 —— 表现为"突发卡顿 + 随后脉冲式补发"。

**修复**：

- 新增 `timeline_persist::ingest_sidecar_event` 作为**单一入口**：解析**一次**，然后按事件
  类型分派给时间线或子代理持久化（两者事件集不相交，因此一次解析足够）；
- 该入口整体放进 `tokio::task::spawn_blocking`，不再占用 tokio worker；
- 原有的两个"从字符串解析"入口改为 `#[cfg(test)]`（生产路径不再需要它们，避免死代码）。

> 顺带纠正一个初期的过度归因：`persist_and_stamp` 一直是**整批一次取锁、一次
> `append_timeline_events`**，并非逐条取锁。因此"daemon 摊平批次"影响的只是**广播帧数**，
> 不影响落库事务次数。

### 2.7 消除空 `set({})` 与 scheduled 全量重拉

- **空 `set({})`**：`registerDaemonSessionHandler` 的状态回调在已 running 时返回 `{}`，
  但 Zustand 仍会生成新 state 对象并**通知全部订阅者**做无意义重算，而 state 帧在整个流式
  期间持续到达。改为在调用 `set` 之前用 `get()` 判断并直接返回。
- **scheduled 全量重拉**：`completeBackgroundLiveIfIdle` 原本每秒先做一次
  `loadSessionMessages({ force: true })`（最多 5000 条，主线程逐条完整 JSON 处理 + 整体替换
  `events` 数组，O(历史长度)）**再**做廉价的 `/state` 探测。改为先做廉价探测，重拉节流到 3s；
  **回合一旦结束必定补一次**，最终内容不会丢。

---

## 三、明确否决的两项（依据实测，不是遗漏）

对照文档建议的 ③"合并点前移 / daemon 不摊平批次"在文档自身的第七节被标为**待重测**：
"上一轮接通的 IPC/秒 读数为 4–12 帧/秒，与本节的'每事件一帧'在数量级上似乎不一致……
建议在纯文本流式期间重测该数值，再决定 ③ 的优先级。"

同项目的第三轮排查已给出结论：**"实测 IPC/秒 仅 4–12，帧速率本就不高，不值得动协议"**，
并把"daemon 逐事件广播合并帧"从高优先级**划掉**。

据此本轮**不做**帧合并协议改造：

1. 它是一次**协议层改动**，需客户端同步改并保留兼容分支，风险不低；
2. 其收益的前置假设（每秒数百帧）已被实测否定；
3. 在假设未重新确认前动协议，违反本项目已经吃过三次亏的那条纪律 —— 不要用"应该会很贵"下结论。

同理，**帧边界提交（对照文档 ②）本轮也未实施**：它的收益同样是"合并每秒 N 次 store 写入"，
而实测入站 WS 帧速率只有 4–12/秒，可合并的量很小；且分帧绘制已经承担了"让文字均匀落地"
的职责，手感问题不再由提交时机主导。**若后续在纯文本流式期间重测 `IPC/秒` 得到数百的量级，
这两项应重新评估。**

---

## 四、验证

| 验证项 | 结果 |
|---|---|
| 新增测试 | 45 项全通过（体积边界 11、身份协调 8、分帧绘制 18、平滑度 10、突流源 8 —— 含 1 项修复后重跑） |
| `assistant-ui/` + `dev/` 目录 | ✅ 16 文件 / **257 项**全通过（含最重的 `CodeMuxAssistantRuntime.test.tsx`，67 项 / 38s） |
| `agentStore.test.ts` | ✅ 108 项全通过 |
| 前端类型检查 `npx tsc --noEmit` | ✅ 改动文件**零错误**（仅剩 5 个既有错误，位于未改动文件） |
| `npm run build:daemon` | ✅ `Finished dev profile in 57s`，**零警告**（清理了重构引入的 3 个警告） |
| `cargo test --lib agent::` | ✅ 170 项全通过 |
| sidecar 全量 | ✅ 631 项中 624 通过 → 7 项失败**经隔离重跑确认是负载抖动**：隔离运行 64/64 通过，且耗时从 56.7s 降到 11.9s（个别用例 2232ms → 397ms，5× 以上）。失败项全部是 pi/claude 子进程的时序竞态，与本次改动无关（当时有 cargo 编译在抢 CPU） |

---

## 五、本轮**未**验证的部分（诚实边界）

- **没有做端到端实测**。全部结论来自静态核验 + 单元测试；**没有启动 `dev:desktop` 采集真实
  的 FPS / 长任务 / 平滑度曲线**。因此各修复的**相对权重仍未校准**。
- 平滑度指标是**新加的读数**，还没有真实数据可对照。它的价值要等下一次现场复现才能兑现。
- **分帧绘制的提交成本是一个真实的未知数**：它把流式期的 React commit 从约 20–40 次/秒
  提高到最多 60 次/秒（每次内容更小）。Paseo 在 RN 上验证过这个取舍，但 CodeMUX 的
  `Streamdown` 每次 commit 要重跑尾部代码块的分词 —— **这个代价值得实测**。若浮层显示
  `AgentThread` 的累计毫秒占比明显上升而 FPS 未改善，应把 horizon 调大（例如 250ms）
  或改用更低的绘制节拍。已提供 `localStorage['codemux:textRevealHorizonMs']` 作为调节开关。
- `file_snapshot.original_content` 的体积问题**只被部分缓解**（去掉了重复解析与阻塞），
  没有加体积上限 —— 因为它是统计与 diff 的输入。真正的解法是让它不进热路径（懒加载），
  属于结构性改动，未在本轮做。

---

## 六、下一轮验证方法

1. **完全重启** `npm run dev:desktop`（daemon 与 sidecar 都不会热重载，必须重建后重启）。
2. `Ctrl+Shift+D` 打开浮层，跑一次"读取多个文件 + 长文本输出"的会话，记录：
   - **`长任务/秒` 的累计值** —— 这是体积上限是否命中的直接判据（期望显著下降）；
   - **`流式平滑度` 与 `更新间隔 p50/p95`** —— 这是分帧绘制是否生效的直接判据
     （期望 CV 下降、推进帧占比上升、p95 下降）；
   - **`AgentThread` 的 commit 数与累计毫秒** —— 用来判断分帧绘制的提交成本是否过重。
3. A/B 对照：在控制台 `localStorage.setItem('codemux:textRevealHorizonMs','0')` 后刷新，
   即为"到达即绘制"基线；对比两组平滑度读数。**两个指标必须一起看。**
4. 突流复现：用 `createBurstyStreamSchedule({ seed })` + `pumpBurstySchedule` 以固定种子
   回放，使改动前后可比。
