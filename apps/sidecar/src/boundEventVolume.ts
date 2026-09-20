/**
 * 工具输出的体积边界。
 *
 * 对应 Paseo 的第一道边界（其 `agent-timeline-content.ts:4` 的
 * `TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024` 及 `docs/timeline-sync.md:17-20`
 * 的不变量）：**工具输出在进入任何投递路径之前就被截断，且录制（落库）与广播
 * 共用同一个已截断对象** —— 否则会出现"库里是截断的、WS 发的是全量"这种分裂。
 *
 * CodeMUX 把这个截断点放在 sidecar **唯一的 stdout 出口**
 * （`streamEventBatcher.ts` 的 `writeJsonLine`，已确认全仓源码无其它 stdout 写点）。
 * 因此 daemon 收到的就已经是截断后的 JSON，落库副本与广播副本必然同源，
 * 结构上不可能分裂；同时也省掉了 IPC 与 3 次 serde 解析的体积成本。
 *
 * 为什么这是 CodeMUX 当前单项收益最大的一项：全仓原本**没有任何** agent 工具
 * 输出上限。Read 一个文件就会把整份文件内容塞进 `tool_finished.content`，
 * 一路流过 IPC → SQLite → WS → 客户端 `structuredClone`，实测长任务稳定在
 * 94–105ms，与本模块引入前的多兆字节结构化克隆量级吻合。
 *
 * ## 刻意不截断的字段（重要）
 *
 * - `file_snapshot.original_content`：daemon 侧 `turn_artifact_summary.rs:96`
 *   用它计算增删行统计，截断会让统计失真；它同时也是编辑后 diff 的"旧内容"。
 *   它的成本另行处理（sidecar 改异步读取、daemon 减少重复解析），不在这里砍。
 * - `assistant_message.content` / `user_message.content`：这是模型回答与用户
 *   提问的**本体**，是权威内容，不属于"工具输出"，绝不能截断。
 */

/** 工具输出正文（Read/Bash/Grep 等的完整输出）。与 Paseo 对齐取 64 KiB。 */
const TOOL_OUTPUT_MAX_CHARS = 64 * 1024;

/** 工具调用入参（Write 会携带整份新文件内容）。放得比输出宽，但仍有界。 */
const TOOL_INPUT_MAX_CHARS = 256 * 1024;

/** 流式中的工具入参增量（tool call 预览）。 */
const TOOL_INPUT_DELTA_MAX_CHARS = 64 * 1024;

/** 截断提示。直接拼进内容里，使截断对用户可见而不依赖 UI 改动。 */
const TRUNCATION_NOTICE = '\n\n… [内容过长，已截断]';

function truncationNotice(originalChars: number, keptChars: number): string {
  const droppedKb = Math.max(1, Math.round((originalChars - keptChars) / 1024));
  return `${TRUNCATION_NOTICE}（原始约 ${Math.round(originalChars / 1024)} KiB，省略约 ${droppedKb} KiB）`;
}

/**
 * 按字符数截断，并把剪裁点回退到不与代理对（surrogate pair）中间对齐的位置，
 * 避免把一个 emoji / 组合字符从中间切开而产生乱码。
 */
function clipAtSafeBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let end = maxChars;
  const code = value.charCodeAt(end - 1);
  // 高位代理（0xD800–0xDBFF）后面跟的必是低位代理，此处切开会产生孤立代理。
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function boundString(
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: boolean; originalChars: number } {
  if (typeof value !== 'string' || value.length <= maxChars) {
    return { value, truncated: false, originalChars: 0 };
  }
  const clipped = clipAtSafeBoundary(value, maxChars);
  return {
    value: clipped + truncationNotice(value.length, clipped.length),
    truncated: true,
    originalChars: value.length,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 给 `tool_started.input` 的每个字符串值设上限（Write 的 file content 等）。 */
function boundToolInput(input: unknown): { value: unknown; truncated: boolean } {
  if (!isPlainObject(input)) {
    return { value: input, truncated: false };
  }
  let truncated = false;
  const next: Record<string, unknown> = { ...input };
  for (const [key, raw] of Object.entries(input)) {
    const bounded = boundString(raw, TOOL_INPUT_MAX_CHARS);
    if (bounded.truncated) {
      next[key] = bounded.value;
      truncated = true;
    }
  }
  return { value: truncated ? next : input, truncated };
}

/**
 * 对一条出向消息做体积边界处理。返回原对象引用（未超限时）或一个新的受限副本，
 * 因此调用方无需担心无谓的分配。
 */
export function boundEventVolume(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const bounded = boundEventVolume(item);
      if (bounded !== item) {
        changed = true;
      }
      return bounded;
    });
    return changed ? next : value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const type = value.type;

  if (type === 'codemux_event_batch') {
    const events = value.events;
    if (!Array.isArray(events)) {
      return value;
    }
    const bounded = boundEventVolume(events);
    return bounded === events ? value : { ...value, events: bounded };
  }

  if (type === 'stream_event') {
    const inner = value.event;
    const bounded = boundEventVolume(inner);
    return bounded === inner ? value : { ...value, event: bounded };
  }

  if (type === 'tool_finished') {
    const content = boundString(value.content, TOOL_OUTPUT_MAX_CHARS);
    if (!content.truncated) {
      return value;
    }
    return {
      ...value,
      content: content.value,
      content_truncated: true,
      content_full_chars: content.originalChars,
    };
  }

  if (type === 'tool_started') {
    const input = boundToolInput(value.input);
    if (!input.truncated) {
      return value;
    }
    return { ...value, input: input.value, input_truncated: true };
  }

  if (type === 'tool_input_delta') {
    const partial = boundString(value.partial_json, TOOL_INPUT_DELTA_MAX_CHARS);
    if (!partial.truncated) {
      return value;
    }
    return {
      ...value,
      partial_json: partial.value,
      partial_json_truncated: true,
      partial_json_full_chars: partial.originalChars,
    };
  }

  return value;
}
