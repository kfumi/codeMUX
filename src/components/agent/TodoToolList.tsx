import { TodoStatusIcon } from './TodoStatusIcon';
import type { TodoItem } from '@/types/agent';

/**
 * 待办工具消息（`TodoWrite` / `update_plan` / …）展开后的内容：一行一条待办，
 * 行首是状态图标。`in_progress` 且带 `activeForm` 时展示进行时文案（与待办面板一致）。
 */
export function TodoToolList({
  items,
  explanation,
}: {
  items: TodoItem[];
  explanation?: string;
}) {
  if (items.length === 0) {
    return explanation ? (
      <p data-slot="tool-todo-list" className="text-ui-caption text-muted-foreground">
        {explanation}
      </p>
    ) : null;
  }

  return (
    <div data-slot="tool-todo-list" className="flex flex-col gap-1">
      {explanation ? (
        <p className="text-ui-caption leading-relaxed text-muted-foreground">{explanation}</p>
      ) : null}
      {items.map((item, index) => (
        <TodoToolListRow key={`${item.status}-${index}`} item={item} />
      ))}
    </div>
  );
}

function TodoToolListRow({ item }: { item: TodoItem }) {
  const text = item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content;

  return (
    <div
      data-slot="tool-todo-item"
      data-status={item.status}
      className="flex items-start gap-2 text-ui-caption leading-relaxed"
    >
      <TodoStatusIcon status={item.status} className="mt-0.5" />
      <span
        className={
          item.status === 'completed'
            ? 'text-muted-foreground line-through'
            : item.status === 'in_progress'
              ? 'text-foreground'
              : 'text-muted-foreground'
        }
      >
        {text}
      </span>
    </div>
  );
}
