import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ThinkingBlockProps {
  thinking: string;
}

export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!thinking.trim()) return null;

  return (
    <div className="border rounded-md bg-muted/30 my-2">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span>思考过程</span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 text-sm text-muted-foreground whitespace-pre-wrap border-t pt-2">
          {thinking}
        </div>
      )}
    </div>
  );
}
