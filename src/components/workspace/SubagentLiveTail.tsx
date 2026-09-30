import { useMemo } from 'react';
import { Streamdown, parseMarkdownIntoBlocks } from 'streamdown';

import { CODEMUX_MARKDOWN_STREAMDOWN_PROPS } from '@/components/assistant-ui/markdown-text';
import { ActivityStepThinking } from '@/components/assistant-ui/activity-run';
import { useStreamingTextReveal } from '@/components/agent/assistant-ui/useStreamingTextReveal';
import { createIncrementalBlockParser } from '@/lib/incrementalMarkdownBlocks';
import type { SubagentLiveTail } from '@/lib/subagentStreamingTail';

/**
 * 子智能体的**未提交正文尾部**：它已经到达、但 provider 的 `assistant_message` 信封
 * 还没来，所以还不在时间线的已提交消息里。信封一到，尾部清空、文字挪进已提交消息，
 * 两者不会同时显示同一段（判据见 `subagentLiveTail`）。
 *
 * 为什么要单独一个组件：主线程的实时正文读的是 `agentStore` 的实时缓冲，delta 从不
 * 进 `events[]`；子智能体是反过来的（daemon 为了历史可回放把每条 delta 都持久化），
 * 于是同一个「哪些增量还没提交」的语义要在两个地方各实现一次。这个组件就是共享那半
 * 语义的渲染端——投影在 `subagentStreamingTail`（纯函数），绘制节流复用
 * `useStreamingTextReveal`。
 *
 * **分帧绘制不是可选项**：该 hook 的文档里记着一条实测约束——每次可见提交都会让
 * `Streamdown` 对累积正文重新分块并对尾部未闭合代码块重跑 Shiki 分词，按 60Hz 提交
 * 等于每秒 60 次 Markdown 解析 + 语法高亮。所以这里同样必须走它，不能"到达即绘制"。
 */
export function SubagentLiveTailView({
  tail,
  streaming,
}: {
  tail: SubagentLiveTail;
  /** 子智能体是否仍在运行；终态时立刻补全全文，不留残缺的最后一帧。 */
  streaming: boolean;
}) {
  // 增量分块：只重解析尾部那一块，避免每次提交都对累积全文重新分块。
  const blockParser = useMemo(() => createIncrementalBlockParser(parseMarkdownIntoBlocks), []);
  const revealedText = useStreamingTextReveal(tail.text, streaming && tail.streaming);
  const revealedThinking = useStreamingTextReveal(tail.thinking, streaming && tail.streaming);

  if (!tail.thinking && !tail.text) {
    return null;
  }

  return (
    <div data-slot="subagent-live-tail" className="w-full min-w-0 space-y-1 text-ui-body leading-relaxed">
      {tail.thinking ? (
        <div data-streaming-reasoning="true" className="w-full min-w-0">
          <ActivityStepThinking
            text={tail.thinking}
            streaming={streaming}
            body={(
              <pre className="whitespace-pre-wrap font-sans text-ui-body leading-relaxed text-muted-foreground">
                {revealedThinking}
              </pre>
            )}
          />
        </div>
      ) : null}
      {tail.text ? (
        <div
          data-streaming-text="markdown"
          className="relative text-ui-body leading-relaxed text-foreground"
        >
          <Streamdown
            {...CODEMUX_MARKDOWN_STREAMDOWN_PROPS}
            parseMarkdownIntoBlocksFn={blockParser}
          >
            {revealedText}
          </Streamdown>
          <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom" />
        </div>
      ) : null}
    </div>
  );
}
