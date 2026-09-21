// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkTask } from '../../types/workTask';

const {
  projectsMock,
  projectState,
  settingsState,
  workTaskState,
  createTask,
  updateTask,
  getRepositoryState,
  toastMocks,
} = vi.hoisted(() => {
  const projectsMock = [
    { id: 'p1', name: '项目一', path: 'C:/repo/one', created_at: '', updated_at: '' },
    { id: 'p2', name: '项目二', path: 'C:/repo/two', created_at: '', updated_at: '' },
  ];
  // 模拟 zustand：state 对象必须稳定（引用不变），否则 effect 依赖每次渲染都变。
  const projectState = {
    projects: projectsMock,
    fetchProjects: () => undefined,
  };
  const settingsState: { config: unknown } = { config: null };
  const createTask = vi.fn();
  const updateTask = vi.fn();
  const workTaskState = { createTask, updateTask };
  return {
    projectsMock,
    projectState,
    settingsState,
    workTaskState,
    createTask,
    updateTask,
    getRepositoryState: vi.fn(),
    toastMocks: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector?: (state: typeof projectState) => unknown) =>
    selector ? selector(projectState) : projectState,
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector?: (state: typeof settingsState) => unknown) =>
    selector ? selector(settingsState) : settingsState,
}));

vi.mock('../../stores/workTaskStore', () => ({
  useWorkTaskStore: (selector?: (state: typeof workTaskState) => unknown) =>
    selector ? selector(workTaskState) : workTaskState,
}));

vi.mock('../../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    git: {
      getRepositoryState,
    },
    workTasks: {},
  },
}));

vi.mock('sonner', () => ({
  toast: toastMocks,
}));

// 选择器组件依赖重上下文（providers / runtime），编辑器表单本身的行为与它们无关，
// 直接替身——但把编辑器传下去的 props 透出到 data-* 上，供默认值断言。
vi.mock('../agent/AgentSelector', () => ({
  AgentSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <button
      type="button"
      data-testid="agent-selector"
      data-value={value}
      onClick={() => onChange('codex')}
    >
      切换种类
    </button>
  ),
}));

vi.mock('../agent/AgentModelSelector', () => ({
  AgentModelSelector: ({
    agentKind,
    value,
    activeProviderId,
  }: {
    agentKind: string;
    value: string;
    activeProviderId: string | null;
  }) => (
    <div
      data-testid="agent-model-selector"
      data-agent-kind={agentKind}
      data-model={value}
      data-provider={activeProviderId ?? ''}
    />
  ),
}));

// 项目选择器替身：一个原生 select，便于在测试里切换项目。
vi.mock('../automation/AutomationProjectPicker', () => ({
  AutomationProjectPicker: ({
    projects,
    value,
    onChange,
  }: {
    projects: Array<{ id: string; name: string }>;
    value: string | null;
    onChange: (projectId: string | null) => void;
  }) => (
    <select
      aria-label="项目选择"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">未选择</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  ),
}));

import { TaskEditorDialog } from './TaskEditorDialog';

const noop = vi.fn();

function makeTask(overrides: Partial<WorkTask> & Pick<WorkTask, 'id'>): WorkTask {
  const now = new Date('2026-01-01T00:00:00Z').toISOString();
  return {
    projectId: 'p1',
    title: overrides.id,
    instruction: '',
    agentKind: 'claude_code',
    providerId: null,
    model: null,
    useWorktree: false,
    baseBranch: null,
    workBranch: null,
    worktreePath: null,
    status: 'todo',
    failureReason: null,
    lastError: null,
    runSeq: 0,
    sortOrder: 0,
    sessionId: null,
    resultSummary: null,
    filesChanged: null,
    additions: null,
    deletions: null,
    mergeCommit: null,
    completionKind: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    settledAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function getWorktreeCheckbox(): HTMLInputElement {
  return screen.getByLabelText('在独立 worktree 中执行') as HTMLInputElement;
}

/** 设置里的「智能体运行时」默认配置：默认种类 + 各类型的默认供应商/模型。 */
function agentDefaultsFixture(defaultAgentKind: 'claude_code' | 'codex' = 'codex') {
  return {
    active_provider_id: 'prov-active',
    agent_defaults: { default_agent_kind: defaultAgentKind },
    agent_configs: {
      claude_code: { default_provider_id: 'prov-claude', default_model: 'claude-sonnet-4-5' },
      codex: { default_provider_id: 'prov-codex', default_model: 'gpt-5-codex' },
    },
    model_providers: [],
  };
}

describe('TaskEditorDialog 默认智能体与模型', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    settingsState.config = null;
  });

  it('新建任务取设置里的默认智能体种类与该种类的默认模型', () => {
    settingsState.config = agentDefaultsFixture();

    render(<TaskEditorDialog open onOpenChange={noop} />);

    expect(screen.getByTestId('agent-selector').getAttribute('data-value')).toBe('codex');
    const modelSelector = screen.getByTestId('agent-model-selector');
    expect(modelSelector.getAttribute('data-agent-kind')).toBe('codex');
    expect(modelSelector.getAttribute('data-model')).toBe('gpt-5-codex');
    expect(modelSelector.getAttribute('data-provider')).toBe('prov-codex');
  });

  it('切换智能体种类后换成该种类的默认模型，不沿用上一个种类', () => {
    settingsState.config = agentDefaultsFixture('claude_code');

    render(<TaskEditorDialog open onOpenChange={noop} />);
    expect(screen.getByTestId('agent-model-selector').getAttribute('data-model')).toBe(
      'claude-sonnet-4-5',
    );

    // 替身把种类切到 codex。
    fireEvent.click(screen.getByTestId('agent-selector'));

    const modelSelector = screen.getByTestId('agent-model-selector');
    expect(modelSelector.getAttribute('data-agent-kind')).toBe('codex');
    expect(modelSelector.getAttribute('data-model')).toBe('gpt-5-codex');
    expect(modelSelector.getAttribute('data-provider')).toBe('prov-codex');
  });

  it('编辑任务沿用任务自身的智能体与模型，不被设置默认值覆盖', () => {
    settingsState.config = agentDefaultsFixture();

    render(
      <TaskEditorDialog
        open
        onOpenChange={noop}
        task={makeTask({
          id: 't9',
          agentKind: 'claude_code',
          providerId: 'p-x',
          model: 'claude-opus',
        })}
      />,
    );

    expect(screen.getByTestId('agent-selector').getAttribute('data-value')).toBe('claude_code');
    expect(screen.getByTestId('agent-model-selector').getAttribute('data-model')).toBe(
      'claude-opus',
    );
  });

  it('设置里没有默认模型时回落为 null，交给选择器自行定夺', () => {
    settingsState.config = { active_provider_id: null, agent_defaults: {}, agent_configs: {} };

    render(<TaskEditorDialog open onOpenChange={noop} />);

    const modelSelector = screen.getByTestId('agent-model-selector');
    expect(modelSelector.getAttribute('data-model')).toBe('');
    expect(modelSelector.getAttribute('data-provider')).toBe('');
  });
});

describe('TaskEditorDialog worktree 区块', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('新建任务默认勾选 worktree 且显示基线分支输入', () => {
    render(<TaskEditorDialog open onOpenChange={noop} />);

    expect(getWorktreeCheckbox().checked).toBe(true);
    expect(screen.getByLabelText('基线分支')).toBeTruthy();
  });

  it('取消勾选隐藏基线分支输入，重新勾选后恢复', () => {
    render(<TaskEditorDialog open onOpenChange={noop} />);

    fireEvent.click(getWorktreeCheckbox());
    expect(getWorktreeCheckbox().checked).toBe(false);
    expect(screen.queryByLabelText('基线分支')).toBeNull();

    fireEvent.click(getWorktreeCheckbox());
    expect(getWorktreeCheckbox().checked).toBe(true);
    expect(screen.getByLabelText('基线分支')).toBeTruthy();
  });

  it('选中项目且勾选 worktree 时预取当前分支作为占位提示', async () => {
    getRepositoryState.mockResolvedValue({ currentBranch: 'main' });

    render(<TaskEditorDialog open onOpenChange={noop} />);
    fireEvent.change(screen.getByLabelText('项目选择'), { target: { value: 'p1' } });

    await vi.waitFor(() => {
      expect(getRepositoryState).toHaveBeenCalledWith('C:/repo/one');
      const input = screen.getByLabelText('基线分支') as HTMLInputElement;
      expect(input.placeholder).toContain('main');
    });
  });

  it('预取失败静默：占位文案保持默认', async () => {
    getRepositoryState.mockRejectedValue(new Error('boom'));

    render(<TaskEditorDialog open onOpenChange={noop} />);
    fireEvent.change(screen.getByLabelText('项目选择'), { target: { value: 'p2' } });

    await vi.waitFor(() => {
      expect(getRepositoryState).toHaveBeenCalled();
      const input = screen.getByLabelText('基线分支') as HTMLInputElement;
      expect(input.placeholder).toBe('默认：项目当前分支');
    });
  });

  it('提交时 useWorktree 落库，基线分支空串转 null', async () => {
    getRepositoryState.mockResolvedValue({ currentBranch: 'dev' });
    createTask.mockResolvedValue(makeTask({ id: 'n1' }));

    render(<TaskEditorDialog open onOpenChange={noop} />);

    // 标题 label 内含「*」必填标记节点，用正则匹配。
    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '新任务' } });
    fireEvent.change(screen.getByLabelText('项目选择'), { target: { value: 'p1' } });

    fireEvent.click(screen.getByText('创建'));

    await vi.waitFor(() => {
      expect(createTask).toHaveBeenCalledTimes(1);
    });
    const input = createTask.mock.calls[0][0];
    expect(input.useWorktree).toBe(true);
    expect(input.baseBranch).toBeNull();
  });

  it('编辑任务沿用任务自身的 useWorktree / baseBranch', () => {
    render(
      <TaskEditorDialog
        open
        onOpenChange={noop}
        task={makeTask({ id: 't1', useWorktree: true, baseBranch: 'feature/x' })}
      />,
    );

    expect(getWorktreeCheckbox().checked).toBe(true);
    const input = screen.getByLabelText('基线分支') as HTMLInputElement;
    expect(input.value).toBe('feature/x');
  });
});
