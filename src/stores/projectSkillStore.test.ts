// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSkill } from '../types/skill';

const listProjectMock = vi.fn<(root: string, agentKind: string, force?: boolean) => Promise<ProjectSkill[]>>();

vi.mock('../lib/facades/daemon-facade', () => ({
  daemonFacade: {
    skills: {
      listProject: listProjectMock,
    },
  },
}));


const projectSkill: ProjectSkill = {
  name: 'review',
  displayName: 'Review',
  description: 'Review the project',
  diskPath: 'C:\\project\\.claude\\skills\\review',
  source: '.claude',
  relativePath: '.claude/skills/review',
};

describe('project skill store', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    listProjectMock.mockResolvedValue([projectSkill]);
    const { useProjectSkillStore } = await import('./projectSkillStore');
    useProjectSkillStore.getState().invalidate();
  });

  it('loads project skills for the selected agent and caches the result', async () => {
    const { useProjectSkillStore } = await import('./projectSkillStore');

    await useProjectSkillStore.getState().load('C:\\project', 'claude_code');
    await useProjectSkillStore.getState().load('C:\\project', 'claude_code');

    expect(listProjectMock).toHaveBeenCalledTimes(1);
    expect(listProjectMock).toHaveBeenCalledWith('C:\\project', 'claude_code', false);
    expect(useProjectSkillStore.getState().entries['C:\\project\u0000claude_code']?.skills).toEqual([projectSkill]);

    await useProjectSkillStore.getState().load('C:\\project', 'claude_code', true);
    expect(listProjectMock).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight request for the same project and agent', async () => {
    let resolveRequest: ((skills: ProjectSkill[]) => void) | undefined;
    listProjectMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    const { useProjectSkillStore } = await import('./projectSkillStore');

    const first = useProjectSkillStore.getState().load('C:\\project', 'codex');
    const second = useProjectSkillStore.getState().load('C:\\project', 'codex');
    resolveRequest?.([projectSkill]);
    await Promise.all([first, second]);

    expect(listProjectMock).toHaveBeenCalledTimes(1);
  });
});
