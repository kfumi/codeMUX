import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import {
  computerUseApprovalOptions,
  computerUseApprovalReason,
  type ComputerUseApprovalChoice,
  type ComputerUseApprovalRequest,
} from '../../lib/computerUseApprovals';
import { cn } from '../../lib/utils';

interface ComputerUseApprovalCardProps {
  request: ComputerUseApprovalRequest;
  onResponse: (choice: ComputerUseApprovalChoice) => void | Promise<void>;
}

/**
 * 电脑控制放行的审批卡（工单 03）：与原生权限卡并列渲染在输入框上方。
 *
 * 粒度差异直接体现在选项上：只读且允许记住时给「本会话记住」，输入动作与
 * 敏感场景只有「放行 / 拦截」——后者不是界面偷懒，是 daemon 侧 decide()
 * 根本不认记住。
 */
export function ComputerUseApprovalCard({ request, onResponse }: ComputerUseApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const options = computerUseApprovalOptions(request);
  const sensitive = Boolean(request.sensitive);

  const respond = async (choice: ComputerUseApprovalChoice) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResponse(choice);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg settings-tile p-2">
      <div className="flex items-center gap-2 px-1 text-ui-body">
        <span
          className={cn(
            'flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-ui-caption font-medium',
            sensitive ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {sensitive ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
          {sensitive ? `敏感场景 · ${request.sensitive}` : '电脑控制'}
        </span>
        <span className="min-w-0 truncate text-foreground">{request.summary}</span>
      </div>
      <p className="mt-1 px-1 text-ui-caption text-muted-foreground">
        {computerUseApprovalReason(request)}
      </p>

      <div className="mt-2 space-y-px overflow-hidden rounded-lg border border-border">
        {options.map((option) => (
          <button
            key={option.choice}
            type="button"
            disabled={submitting}
            onClick={() => void respond(option.choice)}
            className={cn(
              'flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors duration-fast ease-motion-out',
              'hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
              option.choice === 'reject' ? 'text-muted-foreground' : 'text-foreground',
              submitting && 'cursor-wait opacity-70',
            )}
          >
            <span className="text-ui-body font-medium">{option.label}</span>
            <span className="min-w-0 flex-1 truncate text-ui-caption text-muted-foreground">
              {option.description}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
