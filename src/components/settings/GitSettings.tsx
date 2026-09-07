import { useEffect, useState } from 'react';
import { Cpu, GitCommitHorizontal, GitPullRequest } from 'lucide-react';

import { resolveModelDisplayName } from '../../lib/providerModels';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { useSettingsStore } from '../../stores/settingsStore';
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

const textareaClass =
  'flex min-h-[110px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0';

/** 生成模型 + 提交说明 + 拉取请求指令。 */
export function GitSettings() {
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
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="text-sm text-foreground/74">生成模型</label>
        <div className="space-y-3 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <Cpu className="h-4 w-4 text-foreground/58" />
              AI 生成所用模型
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              提交信息与 PR 描述生成所用的模型；未选择时使用默认供应商模型。
            </p>
          </div>
          <GitModelSelect />
        </div>
      </div>

      <div className="space-y-3">
        <label className="text-sm text-foreground/74">提交说明</label>
        <div className="space-y-2 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <GitCommitHorizontal className="h-4 w-4 text-foreground/58" />
              自定义提交指引
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">已添加到提交信息生成提示中</p>
          </div>
          <textarea
            aria-label="提交说明"
            data-testid="git-commit-instructions"
            className={textareaClass}
            placeholder="添加提交消息指引..."
            value={commitValue}
            onChange={(event) => setCommitDraft(event.target.value)}
            onBlur={saveCommitDraft}
          />
        </div>
      </div>

      <div className="space-y-3">
        <label className="text-sm text-foreground/74">拉取请求指令</label>
        <div className="space-y-2 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/90">
              <GitPullRequest className="h-4 w-4 text-foreground/58" />
              自定义 PR 指引
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">已添加到 PR 标题/描述生成提示中</p>
          </div>
          <textarea
            aria-label="拉取请求指令"
            data-testid="git-pr-instructions"
            className={textareaClass}
            placeholder="添加拉取请求指引..."
            value={pullRequestValue}
            onChange={(event) => setPullRequestDraft(event.target.value)}
            onBlur={savePullRequestDraft}
          />
        </div>
      </div>

      <div className="space-y-3">
        <label className="text-sm text-foreground/74">Gitee 凭据</label>
        <div className="space-y-3 rounded-xl bg-muted/40 p-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground/90">Gitee Personal Access Token</div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/60">
              Token 仅保存到系统凭据存储，用于推送后创建 Pull Request。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              aria-label="Gitee Personal Access Token"
              data-testid="gitee-token"
              value={giteeToken}
              onChange={(event) => setGiteeToken(event.target.value)}
              placeholder={giteeConfigured ? '已配置，输入新 Token 可替换' : '输入 Gitee Token'}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              type="button"
              size="sm"
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
                variant="outline"
                size="sm"
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
      </div>
    </div>
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
      <SelectTrigger aria-label="Git 生成供应商和模型" data-testid="git-model-select" className="h-9">
        <SelectValue placeholder="暂无可用供应商或模型">
          {provider && selectedModel ? (
            <span className="flex min-w-0 items-center gap-2">
              <ProviderBrandIcon
                templateId={provider.builtin_template_id}
                name={provider.name}
                size={14}
                className="h-5 w-5 rounded-[5px]"
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
                    className="h-5 w-5 rounded-[5px]"
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
