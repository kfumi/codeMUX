import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';

import { resolveModelDisplayName } from '../../lib/providerModels';
import { useModelDisplayNames } from '../../hooks/useModelDisplayNames';
import { useHostCapabilities } from '../../hooks/useHostCapabilities';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { shellFacade } from '../../lib/facades/shell-facade';
import type { EnvironmentCheckStatus, GitEnvironmentCheck } from '../../lib/desktop-bridge';
import { useSettingsStore } from '../../stores/settingsStore';
import { cn } from '../../lib/utils';
import { TooltipHint } from '../ui/tooltip';
import { ProviderBrandIcon } from './ProviderBrandIcon';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsRow';

const textareaClass =
  'flex min-h-[110px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/60';

/** 生成模型 + 提交说明 + 拉取请求指令。 */
export function GitSettings() {
  useModelDisplayNames();
  const canCheckGit = useHostCapabilities().has('host.git-check');
  const config = useSettingsStore((state) => state.config);
  const setGitSettings = useSettingsStore((state) => state.setGitSettings);
  const [commitDraft, setCommitDraft] = useState<string | null>(null);
  const [pullRequestDraft, setPullRequestDraft] = useState<string | null>(null);
  const [giteeToken, setGiteeToken] = useState('');
  const [giteeConfigured, setGiteeConfigured] = useState(false);
  const [giteeMessage, setGiteeMessage] = useState<string | null>(null);
  const [giteeSaving, setGiteeSaving] = useState(false);

  useEffect(() => {
    void daemonFacade.git.getGiteeCredentialStatus()
      .then(setGiteeConfigured)
      .catch(() => setGiteeConfigured(false));
  }, []);

  if (!config) return null;

  const git = config.git;
  const commitValue = commitDraft ?? git?.commit_instructions ?? '';
  const pullRequestValue = pullRequestDraft ?? git?.pull_request_instructions ?? '';

  const saveCommitDraft = () => {
    if (commitDraft == null || commitDraft === (git?.commit_instructions ?? '')) return;
    const next = commitDraft;
    setCommitDraft(null);
    void setGitSettings({
      commit_instructions: next,
      pull_request_instructions: pullRequestValue,
      provider_id: git?.provider_id ?? null,
      model: git?.model ?? '',
    });
  };

  const savePullRequestDraft = () => {
    if (pullRequestDraft == null || pullRequestDraft === (git?.pull_request_instructions ?? '')) return;
    const next = pullRequestDraft;
    setPullRequestDraft(null);
    void setGitSettings({
      commit_instructions: commitValue,
      pull_request_instructions: next,
      provider_id: git?.provider_id ?? null,
      model: git?.model ?? '',
    });
  };

  return (
    <div className="space-y-8">
      {canCheckGit && <GitExecutableSection />}

      <SettingsSection label="生成模型">
        <SettingsCard>
          <SettingsRow
            stacked
            label="AI 生成所用模型"
            description="提交信息与 PR 描述用它生成；未选择时用默认供应商模型"
            control={<GitModelSelect />}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="提交说明">
        <SettingsCard>
          <SettingsRow
            stacked
            htmlFor="git-commit-instructions"
            label="自定义提交指引"
            description="追加到提交信息的生成提示里"
            control={
              <textarea
                id="git-commit-instructions"
                aria-label="提交说明"
                data-testid="git-commit-instructions"
                className={textareaClass}
                placeholder="添加提交消息指引..."
                value={commitValue}
                onChange={(event) => setCommitDraft(event.target.value)}
                onBlur={saveCommitDraft}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="拉取请求指令">
        <SettingsCard>
          <SettingsRow
            stacked
            htmlFor="git-pr-instructions"
            label="自定义 PR 指引"
            description="追加到 PR 标题与描述的生成提示里"
            control={
              <textarea
                id="git-pr-instructions"
                aria-label="拉取请求指令"
                data-testid="git-pr-instructions"
                className={textareaClass}
                placeholder="添加拉取请求指引..."
                value={pullRequestValue}
                onChange={(event) => setPullRequestDraft(event.target.value)}
                onBlur={savePullRequestDraft}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection label="Gitee 凭据">
        <SettingsCard>
          <SettingsRow
            stacked
            htmlFor="git-gitee-token"
            label="Gitee Personal Access Token"
            description="只存进系统凭据存储，用于推送后创建 Pull Request"
            control={
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <input
                    id="git-gitee-token"
                    type="password"
                    aria-label="Gitee Personal Access Token"
                    data-testid="gitee-token"
                    value={giteeToken}
                    onChange={(event) => setGiteeToken(event.target.value)}
                    placeholder={giteeConfigured ? '已配置，输入新 Token 可替换' : '输入 Gitee Token'}
                    className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring/60"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    data-testid="gitee-token-save"
                    disabled={giteeSaving || !giteeToken.trim()}
                    onClick={() => {
                      setGiteeSaving(true);
                      setGiteeMessage(null);
                      void daemonFacade.git.setGiteeToken(giteeToken)
                        .then(() => {
                          setGiteeToken('');
                          setGiteeConfigured(true);
                          setGiteeMessage('Gitee Token 已保存');
                        })
                        .catch((error) => setGiteeMessage(String(error)))
                        .finally(() => setGiteeSaving(false));
                    }}
                  >
                    保存
                  </Button>
                  {giteeConfigured && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      data-testid="gitee-token-clear"
                      disabled={giteeSaving}
                      onClick={() => {
                        setGiteeSaving(true);
                        setGiteeMessage(null);
                        void daemonFacade.git.clearGiteeToken()
                          .then(() => {
                            setGiteeConfigured(false);
                            setGiteeMessage('Gitee Token 已清除');
                          })
                          .catch((error) => setGiteeMessage(String(error)))
                          .finally(() => setGiteeSaving(false));
                      }}
                    >
                      清除
                    </Button>
                  )}
                </div>
                {giteeMessage && <p className="text-xs text-muted-foreground">{giteeMessage}</p>}
              </div>
            }
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

const GIT_STATUS_META: Record<
  EnvironmentCheckStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  ok: { label: '正常', className: 'border-success/30 bg-success/10 text-success', icon: CheckCircle2 },
  warning: { label: '需升级', className: 'border-warning/35 bg-warning/10 text-warning', icon: TriangleAlert },
  missing: { label: '未找到', className: 'border-destructive/35 bg-destructive/10 text-destructive', icon: AlertCircle },
  error: { label: '异常', className: 'border-destructive/35 bg-destructive/10 text-destructive', icon: AlertCircle },
};

/** 本机 Git 探测(壳独占:host.git-check;浏览器/移动形态不渲染)。 */
function GitExecutableSection() {
  const [check, setCheck] = useState<GitEnvironmentCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCheck(await shellFacade.checkGitEnvironment());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const git = check?.git;
  const pending = loading && !git;
  const meta = GIT_STATUS_META[error ? 'error' : git?.status ?? 'missing'];
  const StatusIcon = meta.icon;

  let detail: ReactNode;
  if (error) {
    detail = error;
  } else if (pending) {
    detail = '正在检测本机 Git…';
  } else if (git?.status === 'ok' && git.path) {
    detail = (
      <span className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-muted-foreground">版本</span>
        <span className="font-mono text-foreground">{git.version ?? '—'}</span>
        <span className="text-muted-foreground">位置</span>
        <TooltipHint content={git.path}>
          <span className="truncate font-mono text-foreground">{git.path}</span>
        </TooltipHint>
      </span>
    );
  } else {
    detail = git?.message ?? '未检测';
  }

  return (
    <SettingsSection label="本机 Git">
      <SettingsCard>
        <SettingsRow
          inlineControl
          label="Git 可执行文件"
          description={detail}
          control={
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-ui-caption font-medium',
                  pending ? 'border-border text-muted-foreground' : meta.className,
                )}
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <StatusIcon className="h-3.5 w-3.5" />
                )}
                {pending ? '检测中' : meta.label}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                className="shrink-0"
                onClick={runCheck}
                disabled={loading}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                重新检测
              </Button>
            </div>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function GitModelSelect() {
  const config = useSettingsStore((state) => state.config);
  const setGitSettings = useSettingsStore((state) => state.setGitSettings);
  const providers = (config?.model_providers ?? []).filter((provider) => provider.enabled);
  const git = config?.git;

  const providerId = git?.provider_id
    ?? config?.active_provider_id
    ?? providers[0]?.id
    ?? '';
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];
  const modelId = git?.model || provider?.default_model || provider?.models[0]?.id || '';
  const selectedModel = provider?.models.find((model) => model.id === modelId)
    ?? provider?.models[0];
  const combinedValue = provider && selectedModel
    ? `${provider.id}::${selectedModel.id}`
    : '';

  const saveDefault = (value: string) => {
    const separator = value.indexOf('::');
    if (separator <= 0) return;
    void setGitSettings({
      commit_instructions: git?.commit_instructions ?? '',
      pull_request_instructions: git?.pull_request_instructions ?? '',
      provider_id: value.slice(0, separator),
      model: value.slice(separator + 2),
    });
  };

  return (
    <Select
      value={combinedValue}
      onValueChange={saveDefault}
      disabled={providers.length === 0}
    >
      <SelectTrigger
        aria-label="Git 生成供应商和模型"
        data-testid="git-model-select"
        size="sm"
        className="w-full sm:w-72"
      >
        <SelectValue placeholder="暂无可用供应商或模型">
          {provider && selectedModel ? (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderBrandIcon
                templateId={provider.builtin_template_id}
                name={provider.name}
                size={14}
                className="h-5 w-5 rounded-2xs"
              />
              <span className="truncate">
                {resolveModelDisplayName({
                  id: selectedModel.id,
                  name: selectedModel.name,
                  providerTemplateId: provider.builtin_template_id,
                })}
              </span>
            </span>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {providers.map((item) => (
          <SelectGroup key={item.id}>
            <SelectLabel>{item.name}</SelectLabel>
            {item.models.map((model) => (
              <SelectItem key={`${item.id}::${model.id}`} value={`${item.id}::${model.id}`}>
                <span className="flex items-center gap-2">
                  <ProviderBrandIcon
                    templateId={item.builtin_template_id}
                    name={item.name}
                    size={14}
                    className="h-5 w-5 rounded-2xs"
                  />
                  <span>
                    {resolveModelDisplayName({
                      id: model.id,
                      name: model.name,
                      providerTemplateId: item.builtin_template_id,
                    })}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
