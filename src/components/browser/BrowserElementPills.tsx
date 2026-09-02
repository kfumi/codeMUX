import { useState } from 'react';
import { Globe, MousePointer2, X } from 'lucide-react';

import { truncateBrowserElementText } from '../../lib/browserElementFormat';
import { browserPageTitle } from '../../lib/browserPage';
import { cn } from '../../lib/utils';
import { useBrowserElementStore, type BrowserElementReference } from '../../stores/browserElementStore';

interface BrowserElementPillsProps {
  sessionId: string;
}

const EMPTY_ELEMENTS: BrowserElementReference[] = [];
const PREVIEW_TEXT_LIMIT = 42;

function previewText(text: string): string {
  const normalized = truncateBrowserElementText(text);
  if (!normalized) return '';
  return normalized.length <= PREVIEW_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, PREVIEW_TEXT_LIMIT)}…`;
}

export function BrowserElementPills({ sessionId }: BrowserElementPillsProps) {
  const elements = useBrowserElementStore((state) => state.elementsBySession[sessionId] ?? EMPTY_ELEMENTS);
  const clear = useBrowserElementStore((state) => state.clear);
  const [open, setOpen] = useState(false);

  if (elements.length === 0) {
    return null;
  }

  return (
    <div
      className="relative mb-1.5 w-fit max-w-full"
      data-testid="browser-element-list"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      {open ? (
        <div
          role="tooltip"
          className="surface-panel absolute bottom-full left-0 z-190 mb-1.5 w-72 max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-border/55 p-1.5 shadow-[0_14px_36px_-24px_hsl(var(--surface-shadow-strong)/0.45)]"
        >
          <ul className="flex flex-col gap-0.5">
            {elements.map((element) => (
              <li
                key={element.id}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5"
              >
                <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ui-caption text-foreground/88">
                    {previewText(element.text) || browserPageTitle('', element.url)}
                  </div>
                  <div className="mt-0.5 font-mono text-code text-muted-foreground">{element.tag}</div>
                  {element.text.trim() ? (
                    <div className="mt-0.5 truncate text-ui-caption text-muted-foreground/80">
                      {browserPageTitle('', element.url)}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div
        className={cn(
          'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border/55 bg-muted/40 px-2 text-ui-caption text-foreground/82',
          open && 'border-border/80 bg-muted/55',
        )}
      >
        <MousePointer2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{elements.length} 个网页元素</span>
        <button
          type="button"
          aria-label="清除全部网页元素"
          className="rounded p-0.5 text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => clear(sessionId)}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
