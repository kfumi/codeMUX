import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '../../lib/utils';

const AGENT_KIND_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  gemini_cli: 'Gemini CLI',
  opencode: 'OpenCode',
};

function agentKindDisplayLabel(kind?: string): string | undefined {
  if (!kind) return undefined;
  return AGENT_KIND_LABELS[kind] ?? kind;
}

function runtimeSwitchCaption(fromKind?: string, toKind?: string): string {
  const fromLabel = agentKindDisplayLabel(fromKind);
  const toLabel = agentKindDisplayLabel(toKind);
  if (fromLabel && toLabel) {
    return `— 已从 ${fromLabel} 切换到 ${toLabel} —`;
  }
  if (toLabel) {
    return `— 已切换到 ${toLabel} —`;
  }
  return '— 已切换智能体 —';
}

interface RuntimeSwitchRowProps {
  fromKind?: string;
  toKind?: string;
  briefing?: string;
}

export function RuntimeSwitchRow({ fromKind, toKind, briefing }: RuntimeSwitchRowProps) {
  const caption = runtimeSwitchCaption(fromKind, toKind);
  const trimmedBriefing = briefing?.trim();

  if (!trimmedBriefing) {
    return (
      <div className="py-3 text-center">
        <span className="text-xs font-medium tracking-normal text-muted-foreground">
          {caption}
        </span>
      </div>
    );
  }

  return <RuntimeSwitchWithBriefing caption={caption} briefing={trimmedBriefing} />;
}

function RuntimeSwitchWithBriefing({ caption, briefing }: { caption: string; briefing: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="py-3">
      <div className="text-center">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-medium tracking-normal text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {caption}
          <ChevronDown
            className={cn(
              'size-3 opacity-70 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </div>
      {open ? (
        <pre className="mt-2 whitespace-pre-wrap wrap-break-word rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-left text-[11px] leading-relaxed text-muted-foreground">
          {briefing}
        </pre>
      ) : null}
    </div>
  );
}
