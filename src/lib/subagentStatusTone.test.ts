import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUBAGENT_STATUS_TONES } from '@/lib/subagentStatusTone';
import type { SubagentStatus } from '@/lib/codeMuxProtocol';

/**
 * 子智能体状态色守卫。
 *
 * 起因：三处状态指示器各写一套色（节点点「运行中」是灰的、标签页点「运行中」是绿的、
 * 面板胶囊「运行中」是主色），看上去像三个不同的状态。现在取色只有一处
 * `src/lib/subagentStatusTone.ts`，这里守住两件事：
 *   1. 语义本身（运行中=黄、已完成=绿、失败=红、已取消=中性）；
 *   2. `globals.css` 的 `.is-*` 节点状态点与同一份语义表对齐（改一处忘另一处就红）。
 */

const GLOBALS_CSS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'styles',
  'globals.css',
);

const EXPECTED_TOKENS: Record<SubagentStatus, string> = {
  running: 'warning',
  completed: 'success',
  failed: 'destructive',
  canceled: 'muted-foreground',
};

describe('子智能体状态色', () => {
  it('运行中黄、已完成绿、失败红、已取消中性灰', () => {
    for (const [status, token] of Object.entries(EXPECTED_TOKENS)) {
      expect(SUBAGENT_STATUS_TONES[status as SubagentStatus].token).toBe(token);
    }
  });

  it('状态点与胶囊都取自己那一档 token', () => {
    for (const [status, tone] of Object.entries(SUBAGENT_STATUS_TONES)) {
      expect(tone.dot, `${status} 的状态点没走 ${tone.token}`).toContain(tone.token);
      expect(tone.pill, `${status} 的胶囊文字没走 ${tone.token}`).toContain(`text-${tone.token}`);
      expect(tone.pill, `${status} 的胶囊底色没走 ${tone.token}`).toContain(`bg-${tone.token}`);
    }
  });

  it('globals.css 的 .is-* 节点状态点与语义表同色', () => {
    const css = readFileSync(GLOBALS_CSS, 'utf8');
    for (const [status, tone] of Object.entries(SUBAGENT_STATUS_TONES)) {
      const rule = new RegExp(
        `\\.subagent-topology-node\\.is-${status}\\s+\\.subagent-topology-node-status-dot\\s*\\{([^}]*)\\}`,
      );
      const match = css.match(rule);
      expect(match, `globals.css 缺少 .is-${status} 的状态点规则`).not.toBeNull();
      expect(match?.[1], `.is-${status} 的状态点颜色与语义表不一致`).toContain(
        `hsl(var(--${tone.token}))`,
      );
    }
  });
});
