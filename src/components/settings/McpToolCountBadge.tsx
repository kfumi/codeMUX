import { BROWSER_TOOL_PREFIX, DESKTOP_TOOL_PREFIX } from '../../lib/builtinMcp';
import { TooltipHint } from '../ui/tooltip';

/**
 * MCP server 的工具数徽章 + 工具名明细(内置条目与用户自建 server 共用)。
 *
 * 数据来源不同、展示一致:
 * - 内置 server:`tools` 由 daemon 现算(`builtin_mcp::visible_tool_names`)——它不在
 *   探测链路里,数量随「浏览器控制 / 电脑控制 / 系统级执行」三个开关变;
 * - 用户自建 server:探测结果(`probeTools[id]`,`tools/list` 的名字)。
 *
 * 空清单的两种含义不能混:内置 server 空 = 开关都关着(要显式说「未启用」,否则看起来
 * 像 0 个工具的 bug);自建 server 空 = 还没探测或探测失败(状态由状态灯与探测按钮表达,
 * 这里不渲染)。
 */
export interface McpToolCountBadgeProps {
  tools: string[];
  /** 内置 server:空清单也要有个说法。 */
  builtin?: boolean;
}

function ToolNameRow({ name }: { name: string }) {
  return (
    <span className="truncate rounded bg-[hsl(var(--foreground)/0.06)] px-1.5 py-0.5 font-mono text-ui-micro text-foreground">
      {name}
    </span>
  );
}

/**
 * tooltip 内容:名字按内置工具面的两个前缀分段(浏览器 / 桌面)便于扫读;名字与前缀
 * 都不匹配(第三方 server 的任意命名)就平铺 —— 不硬造一个空分组出来。
 */
export function McpToolNameList({ tools }: { tools: string[] }) {
  const hasBuiltinPrefix = tools.some(
    (name) => name.startsWith(BROWSER_TOOL_PREFIX) || name.startsWith(DESKTOP_TOOL_PREFIX),
  );
  const groups = hasBuiltinPrefix
    ? [
        {
          key: 'browser',
          label: '浏览器',
          names: tools.filter((name) => name.startsWith(BROWSER_TOOL_PREFIX)),
        },
        {
          key: 'desktop',
          label: '桌面',
          names: tools.filter((name) => !name.startsWith(BROWSER_TOOL_PREFIX)),
        },
      ].filter((group) => group.names.length > 0)
    : [{ key: 'all', label: '', names: tools }];

  return (
    <span className="flex max-h-60 max-w-[22rem] flex-col gap-1 overflow-y-auto pr-0.5">
      {groups.map((group) => (
        <span key={group.key} className="flex flex-col items-start gap-0.5">
          {group.label ? (
            <span className="text-ui-micro text-muted-foreground">
              {group.label} {group.names.length}
            </span>
          ) : null}
          {group.names.map((name) => (
            <ToolNameRow key={name} name={name} />
          ))}
        </span>
      ))}
    </span>
  );
}

export function McpToolCountBadge({ tools, builtin }: McpToolCountBadgeProps) {
  if (tools.length === 0) {
    if (!builtin) return null;
    return (
      <TooltipHint content="「浏览器控制」与「电脑控制」都关着,当前没有可用工具。">
        <span className="shrink-0 cursor-default text-ui-micro font-medium text-muted-foreground">
          · 未启用
        </span>
      </TooltipHint>
    );
  }

  return (
    <TooltipHint content={<McpToolNameList tools={tools} />}>
      <span className="shrink-0 cursor-default text-ui-micro font-medium text-[hsl(var(--success))]">
        · {tools.length} 个工具
      </span>
    </TooltipHint>
  );
}
