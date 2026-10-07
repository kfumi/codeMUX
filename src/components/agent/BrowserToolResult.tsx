import { memo, useMemo, useState } from 'react';
import { extractBrowserShots } from '../../lib/browserToolShots';

export interface BrowserToolResultProps {
  toolName: string;
  result: unknown;
  step?: number;
  beforeShot?: string;
  afterShot?: string;
}

function ShotImage({ src, label, large }: { src: string; label: string; large?: boolean }) {
  return (
    <img
      src={src}
      alt={label}
      data-slot={'browser-shot'}
      className={large ? 'w-full rounded-lg border border-border' : 'h-20 w-auto rounded-md border border-border'}
    />
  );
}
function BrowserToolResultImpl({ result, step, beforeShot, afterShot }: BrowserToolResultProps) {
  const extraction = useMemo(() => extractBrowserShots(result), [result]);
  const [expandedShot, setExpandedShot] = useState<string | null>(null);
  const ownShots = extraction.shots;
  const showContrast = ownShots.length === 0 && (beforeShot !== undefined || afterShot !== undefined);
  return (
    <div data-slot={'browser-tool-result'} className={'space-y-2'}>
      {step !== undefined ? (
        <span data-slot={'browser-step-badge'} className={'inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-ui-caption font-medium text-primary'}>
          第 {step} 步
        </span>
      ) : null}
      {ownShots.length > 0 ? (
        <div>
          <div className={'mb-1.5 text-ui-caption font-medium text-muted-foreground'}>截图</div>
          <div className={'flex flex-wrap gap-2'}>
            {ownShots.map((shot) => (
              <button
                key={shot.slice(0, 32)}
                type={'button'}
                aria-label={'展开截图'}
                onClick={() => setExpandedShot(expandedShot === shot ? null : shot)}
                className={'cursor-pointer rounded-md transition-colors'}
              >
                <ShotImage src={shot} label={'浏览器截图缩略图'} />
              </button>
            ))}
          </div>
          {expandedShot ? (
            <div className={'mt-2'}>
              <ShotImage src={expandedShot} label={'浏览器截图大图'} large />
            </div>
          ) : null}
        </div>
      ) : null}
      {showContrast ? (
        <div className={'grid grid-cols-2 gap-2'}>
          {beforeShot !== undefined ? (
            <figure className={'min-w-0'}>
              <ShotImage src={beforeShot} label={'执行前截图'} />
              <figcaption className={'mt-1 text-ui-caption text-muted-foreground'}>执行前</figcaption>
            </figure>
          ) : null}
          {afterShot !== undefined ? (
            <figure className={'min-w-0'}>
              <ShotImage src={afterShot} label={'执行后截图'} />
              <figcaption className={'mt-1 text-ui-caption text-muted-foreground'}>执行后</figcaption>
            </figure>
          ) : null}
        </div>
      ) : null}
      {extraction.text ? (
        <pre data-slot={'browser-result-text'} className={'max-h-40 overflow-auto rounded-xl border border-border bg-muted p-3 font-mono text-code whitespace-pre-wrap text-foreground'}>
          {extraction.text}
        </pre>
      ) : null}
    </div>
  );
}

export const BrowserToolResult = memo(BrowserToolResultImpl);
