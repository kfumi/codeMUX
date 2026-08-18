import { useMemo, useState } from 'react';

import type { ChatMessage } from '../../lib/eventToMessages';
import { ReasoningRow } from './ReasoningRow';

interface ThinkingGroupRowProps {
  messages: Extract<ChatMessage, { kind: 'reasoning' }>[];
}

export function ThinkingGroupRow({ messages }: ThinkingGroupRowProps) {
  const [open, setOpen] = useState(false);
  const streaming = messages.some((message) => message.streaming);
  const content = useMemo(
    () => messages.map((message) => message.content).join('\n\n'),
    [messages],
  );

  return (
    <ReasoningRow
      content={content}
      collapsed={!open && !streaming}
      streaming={streaming}
      onToggle={() => setOpen((value) => !value)}
    />
  );
}
