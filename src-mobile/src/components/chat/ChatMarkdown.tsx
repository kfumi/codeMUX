import { code } from '@streamdown/code';
import { Streamdown, defaultRehypePlugins } from 'streamdown';

import { MOBILE_MARKDOWN_COMPONENTS } from './markdownComponents';

interface ChatMarkdownProps {
  content: string;
  streaming?: boolean;
}

const SHARED_STREAMDOWN_PROPS = {
  className: 'aui-md',
  components: MOBILE_MARKDOWN_COMPONENTS as never,
  rehypePlugins: Object.values(defaultRehypePlugins),
  linkSafety: { enabled: false },
} as const;

export function ChatMarkdown({ content, streaming = false }: ChatMarkdownProps) {
  if (!content) {
    return null;
  }

  if (streaming) {
    return (
      <div className="relative text-sm leading-6 text-foreground">
        <Streamdown mode="streaming" {...SHARED_STREAMDOWN_PROPS}>
          {content}
        </Streamdown>
        <span
          aria-hidden
          className="ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/60 align-text-bottom"
        />
      </div>
    );
  }

  return (
    <Streamdown
      mode="static"
      {...SHARED_STREAMDOWN_PROPS}
      plugins={{ code }}
      shikiTheme={['github-light', 'github-dark']}
      controls={{ code: { copy: true, download: false }, table: false } as never}
    >
      {content}
    </Streamdown>
  );
}
