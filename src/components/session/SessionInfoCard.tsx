import { Folder, GitBranch } from 'lucide-react';

import { useRepoBranch } from '../../hooks/useRepoBranch';
import { getAgentDefinition } from '../../types/agentRegistry';
import type { Session } from '../../types/session';
import { AgentBrandIcon } from '../agent/AgentBrandIcon';

interface SessionInfoCardProps {
  session: Session;
  workingPath: string | null;
}

export function SessionInfoCard({ session, workingPath }: SessionInfoCardProps) {
  const agentDef = getAgentDefinition(session.agent_kind);
  // 分支优先级：库里的 git_branch（会话建立时所在的分支）→ 回退实时查询工作目录
  // → 两者都拿不到就不显示这一行。传 null 给 hook 表示不发起实时查询，所以正常
  // 情况下悬停不再产生 Git 调用；只有 git_branch 为空的老会话才走兜底。
  const storedBranch = session.git_branch?.trim() || null;
  const { branch: liveBranch } = useRepoBranch(storedBranch ? null : workingPath);
  const branch = storedBranch ?? liveBranch;
  const model = session.model?.trim() ?? '';
  const hasDetails = Boolean(branch || workingPath);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p className="line-clamp-2 text-ui-body font-medium leading-snug text-foreground">
          {session.title || '未命名对话'}
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-ui-caption text-muted-foreground">
          {agentDef ? <AgentBrandIcon agent={agentDef} size="sm" /> : null}
          <span className="truncate">
            {agentDef?.label ?? session.agent_kind}
            {model ? ` · ${model}` : ''}
          </span>
        </div>
      </div>

      {hasDetails ? (
        <>
          <div className="h-px bg-border/55" />
          <div className="flex flex-col gap-2">
            {branch ? (
              <div className="flex items-start gap-2">
                <GitBranch className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-all font-mono text-code leading-snug text-foreground/85">
                  {branch}
                </span>
              </div>
            ) : null}
            {workingPath ? (
              <div className="flex items-start gap-2">
                <Folder className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 break-all font-mono text-code leading-snug text-foreground/85 line-clamp-3">
                  {workingPath}
                </span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
