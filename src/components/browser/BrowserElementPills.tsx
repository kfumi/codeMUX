import { X } from 'lucide-react';

import { truncateBrowserElementText } from '../../lib/browserElementFormat';
import { useBrowserElementStore, type BrowserElementReference } from '../../stores/browserElementStore';

interface BrowserElementPillsProps {
  sessionId: string;
}

const EMPTY_ELEMENTS: BrowserElementReference[] = [];

export function BrowserElementPills({ sessionId }: BrowserElementPillsProps) {
  const elements = useBrowserElementStore((state) => state.elementsBySession[sessionId] ?? EMPTY_ELEMENTS);
  const remove = useBrowserElementStore((state) => state.remove);
  const clear = useBrowserElementStore((state) => state.clear);

  if (elements.length === 0) {
    return null;
  }

  return (
    <div className="mb-1.5 flex flex-col gap-1.5" data-testid="browser-element-list">
      <div className="flex items-center justify-between gap-2 text-ui-caption text-muted-foreground">
        <span>{elements.length} 个网页元素</span>
        <button
          type="button"
          className="text-ui-caption text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => clear(sessionId)}
        >
          撤销
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {elements.map((element) => (
          <span
            key={element.id}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/55 bg-muted/40 px-2 py-1 text-ui-caption text-foreground/82"
          >
            <span className="font-mono text-code text-muted-foreground">{element.tag}</span>
            <span className="truncate">{truncateBrowserElementText(element.text) || element.tag}</span>
            <button
              type="button"
              aria-label="移除网页元素"
              className="rounded p-0.5 text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => remove(sessionId, element.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
