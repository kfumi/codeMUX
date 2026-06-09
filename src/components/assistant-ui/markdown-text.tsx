"use client";

import '@assistant-ui/react-markdown/styles/dot.css';

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { type FC, memo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button';
import { cn } from '@/lib/utils';

const MarkdownTextImpl = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={defaultComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="aui-code-header-root border-border/50 bg-muted/50 mt-2.5 flex items-center justify-between rounded-t-lg border border-b-0 px-3 py-1.5 text-xs">
      <span className="aui-code-header-language text-muted-foreground font-medium lowercase">
        {language}
      </span>
      <TooltipIconButton tooltip="复制" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({ copiedDuration = 3000 }: { copiedDuration?: number } = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    navigator.clipboard.writeText(value).then(
      () => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {},
    );
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        'aui-md-h1 mb-2 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        'aui-md-h2 mt-3 mb-1.5 scroll-m-20 text-sm font-semibold first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        'aui-md-h3 mt-2.5 mb-1 scroll-m-20 text-sm font-semibold first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        'aui-md-h4 mt-2 mb-1 scroll-m-20 text-sm font-medium first:mt-0 last:mb-0',
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn('aui-md-p my-2.5 leading-normal first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        'aui-md-a text-primary hover:text-primary/80 underline underline-offset-2',
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        'aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-2.5 border-s-2 ps-3 italic',
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        'aui-md-ul marker:text-muted-foreground my-2 pl-5 list-disc [&>li]:mt-1',
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        'aui-md-ol marker:text-muted-foreground my-2 pl-5 list-decimal [&>li]:mt-1',
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn('aui-md-hr border-muted-foreground/20 my-2', className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn('aui-md-li leading-normal', className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        'aui-md-pre border-border/50 bg-muted/30 overflow-x-auto rounded-t-none rounded-b-lg border border-t-0 p-3 text-xs leading-relaxed',
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            'aui-md-inline-code border-border/50 bg-muted/50 rounded-md border px-1.5 py-0.5 font-mono text-[0.85em]',
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
