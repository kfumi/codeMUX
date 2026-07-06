// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportableSkill, Skill, SkillApps } from '../types/skill';

const listInstalledMock = vi.fn<() => Promise<Skill[]>>();
const listImportableMock = vi.fn<() => Promise<ImportableSkill[]>>();
const toggleAppMock = vi.fn<
  (id: string, app: string, enabled: boolean) => Promise<void>
>();
const importFromAppsMock = vi.fn<(selected?: string[] | null) => Promise<{ total: number }>>();

vi.mock('../lib/tauri', () => ({
  skillApi: {
    listInstalled: listInstalledMock,
    listImportable: listImportableMock,
    uninstall: vi.fn(),
    toggleApp: toggleAppMock,
    getContent: vi.fn(),
    syncBuiltins: vi.fn(),
    registerFromDisk: vi.fn(),
    importFromApps: importFromAppsMock,
  },
}));

function makeSkill(id: string, name: string, apps: Partial<SkillApps> = {}): Skill {
  return {
    id,
    name,
    display_name: null,
    description: null,
    installed_at: '2026-01-01T00:00:00Z',
    apps: { claude: true, codex: false, gemini: false, opencode: false, ...apps },
    disk_path: null,
    directory: 'alpha',
  };
}

describe('skill store toggleApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listInstalledMock.mockResolvedValue([]);
    listImportableMock.mockResolvedValue([]);
    toggleAppMock.mockResolvedValue(undefined);
    importFromAppsMock.mockResolvedValue({ total: 0 });
  });

  it('updates only the targeted app field in local state', async () => {
    const { useSkillStore } = await import('./skillStore');
    const skill = makeSkill('s1', 'alpha', { claude: true });
    listInstalledMock.mockResolvedValue([skill]);
    await useSkillStore.getState().fetchInstalled();

    await useSkillStore.getState().toggleApp('s1', 'codex', true);

    expect(toggleAppMock).toHaveBeenCalledWith('s1', 'codex', true);
    const stored = useSkillStore.getState().installedSkills.find((s) => s.id === 's1');
    expect(stored?.apps.claude).toBe(true);
    expect(stored?.apps.codex).toBe(true);
    expect(stored?.apps.gemini).toBe(false);
  });

  it('does not modify other skills when toggling one', async () => {
    const { useSkillStore } = await import('./skillStore');
    const s1 = makeSkill('s1', 'alpha', { claude: true });
    const s2 = makeSkill('s2', 'beta', { codex: true });
    listInstalledMock.mockResolvedValue([s1, s2]);
    await useSkillStore.getState().fetchInstalled();

    await useSkillStore.getState().toggleApp('s1', 'gemini', true);

    const skills = useSkillStore.getState().installedSkills;
    const beta = skills.find((s) => s.id === 's2');
    expect(beta?.apps.codex).toBe(true);
    expect(beta?.apps.gemini).toBe(false);
  });

  it('refetches installed list after import finds new skills', async () => {
    const { useSkillStore } = await import('./skillStore');
    importFromAppsMock.mockResolvedValue({ total: 2 });
    listInstalledMock.mockResolvedValue([]);

    await useSkillStore.getState().importFromApps();

    expect(importFromAppsMock).toHaveBeenCalled();
    expect(listInstalledMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when import finds zero skills', async () => {
    const { useSkillStore } = await import('./skillStore');
    importFromAppsMock.mockResolvedValue({ total: 0 });
    listInstalledMock.mockResolvedValue([]);

    await useSkillStore.getState().fetchInstalled();
    const callsBefore = listInstalledMock.mock.calls.length;

    await useSkillStore.getState().importFromApps();

    expect(listInstalledMock.mock.calls.length).toBe(callsBefore);
  });
});
