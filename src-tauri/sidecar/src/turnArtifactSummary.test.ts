import { describe, expect, it } from 'vitest';
import {
  TurnArtifactAggregator,
  isArtifactPathInWorkspace,
  synthesizeTurnArtifactSummaries,
} from './turnArtifactSummary.js';

const CWD = 'D:/project/demo';

describe('TurnArtifactAggregator', () => {
  it('records a successful Write as a new file summary entry', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-1',
      name: 'Write',
      input: { file_path: 'src/app.ts', content: 'export {}\n' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-1',
      is_error: false,
      content: 'ok',
    });

    const summary = aggregator.flushSummary('session-1');
    expect(summary).toMatchObject({
      type: 'system_event',
      subtype: 'session_summary',
      session_id: 'session-1',
    });
    expect(summary?.diffs).toEqual([expect.objectContaining({
      file: 'D:/project/demo/src/app.ts',
      after: 'export {}\n',
      additions: 1,
      deletions: 0,
    })]);
  });

  it('matches Edit oldString against CRLF file snapshots', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'file_snapshot',
      file_path: 'D:/project/demo/src/orderCompleteProcess.vue',
      original_content: '<template>\r\n  <view>old</view>\r\n</template>\r\n',
      is_new: false,
      tool_use_id: 'edit-crlf',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-crlf',
      name: 'Edit',
      input: {
        filePath: 'src/orderCompleteProcess.vue',
        oldString: '<template>\n  <view>old</view>\n</template>',
        newString: '<template>\n  <view>new</view>\n</template>',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-crlf',
      is_error: false,
      content: 'ok',
    });

    expect(aggregator.buildDiffs()).toEqual([expect.objectContaining({
      file: 'D:/project/demo/src/orderCompleteProcess.vue',
      additions: 1,
      deletions: 1,
    })]);
  });

  it('includes multiple edited files in the same turn', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'file_snapshot',
      file_path: 'D:/project/demo/src/a.vue',
      original_content: 'a-old\r\n',
      is_new: false,
      tool_use_id: 'edit-a',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-a',
      name: 'Edit',
      input: { filePath: 'src/a.vue', oldString: 'a-old', newString: 'a-new' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-a',
      is_error: false,
      content: 'ok',
    });
    aggregator.observe({
      type: 'file_snapshot',
      file_path: 'D:/project/demo/src/b.vue',
      original_content: 'b-old\n',
      is_new: false,
      tool_use_id: 'edit-b',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-b',
      name: 'Edit',
      input: { filePath: 'src/b.vue', oldString: 'b-old', newString: 'b-new' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-b',
      is_error: false,
      content: 'ok',
    });

    const files = aggregator.buildDiffs().map((diff) => diff.file).sort();
    expect(files).toEqual([
      'D:/project/demo/src/a.vue',
      'D:/project/demo/src/b.vue',
    ]);
  });

  it('uses file_snapshot for Edit before/after content', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'file_snapshot',
      file_path: 'D:/project/demo/src/app.ts',
      original_content: 'old line\n',
      is_new: false,
      tool_use_id: 'edit-1',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-1',
      name: 'Edit',
      input: {
        file_path: 'src/app.ts',
        old_string: 'old line',
        new_string: 'new line',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-1',
      is_error: false,
      content: 'ok',
    });

    const [diff] = aggregator.buildDiffs();
    expect(diff).toMatchObject({
      file: 'D:/project/demo/src/app.ts',
      before: 'old line\n',
      after: 'new line\n',
      additions: 1,
      deletions: 1,
    });
  });

  it('keeps only the latest successful mutation per file', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-1',
      name: 'Write',
      input: { file_path: 'src/app.ts', content: 'first\n' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-1',
      is_error: false,
      content: 'ok',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-2',
      name: 'Write',
      input: { file_path: 'src/app.ts', content: 'second\n' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-2',
      is_error: false,
      content: 'ok',
    });

    expect(aggregator.buildDiffs()).toEqual([expect.objectContaining({
      file: 'D:/project/demo/src/app.ts',
      after: 'second\n',
    })]);
  });

  it('counts multi-line Write additions like the tool header', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-1',
      name: 'Write',
      input: {
        file_path: 'memory/MEMORY.md',
        content: '# Memory Index\n\n- [link](file.md)',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-1',
      is_error: false,
      content: 'ok',
    });

    const [diff] = aggregator.buildDiffs();
    expect(diff).toMatchObject({
      additions: 3,
      deletions: 0,
    });
  });

  it('skips Edit entries that produce no diff', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'file_snapshot',
      file_path: 'docs/design.md',
      original_content: 'existing content',
      is_new: false,
      tool_use_id: 'edit-1',
    });
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-1',
      name: 'Edit',
      input: {
        file_path: 'docs/design.md',
        old_string: 'missing text',
        new_string: 'replacement',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-1',
      is_error: false,
      content: 'ok',
    });

    expect(aggregator.buildDiffs()).toEqual([]);
  });

  it('parses Codex freeform apply_patch input on successful finish', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'patch-1',
      name: 'apply_patch',
      input: {
        input: '*** Begin Patch\n*** Update File: README.md\n-old\n+new\n*** End Patch',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'patch-1',
      is_error: false,
      content: 'Success',
    });

    expect(aggregator.buildDiffs()).toEqual([expect.objectContaining({
      file: 'D:/project/demo/README.md',
      additions: 1,
      deletions: 1,
    })]);
  });

  it('ignores failed Edit tool calls', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'edit-1',
      name: 'Edit',
      input: {
        file_path: 'src/app.ts',
        old_string: 'old',
        new_string: 'new',
      },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'edit-1',
      is_error: true,
      content: 'failed',
    });

    expect(aggregator.flushSummary('session-1')).toBeNull();
  });

  it('records apply_patch completion from fileChange diffs', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'patch-1',
      name: 'apply_patch',
      input: { changes: [{ kind: 'update', path: 'src/app.ts' }] },
    });
    aggregator.recordApplyPatchCompletion('patch-1', [{
      kind: 'update',
      path: 'src/app.ts',
      diff: '-old\n+new\n',
    }]);
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'patch-1',
      is_error: false,
      content: 'Success',
    });

    expect(aggregator.buildDiffs()).toEqual([expect.objectContaining({
      file: 'D:/project/demo/src/app.ts',
      patch: '-old\n+new\n',
      additions: 1,
      deletions: 1,
    })]);
  });

  it('ignores writes outside the workspace cwd', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-1',
      name: 'Write',
      input: { file_path: 'D:/other/project/outside.ts', content: 'export {}\n' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-1',
      is_error: false,
      content: 'ok',
    });

    expect(aggregator.flushSummary('session-1')).toBeNull();
  });

  it('ignores relative paths that escape the workspace cwd', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'write-1',
      name: 'Write',
      input: { file_path: '../outside.ts', content: 'export {}\n' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'write-1',
      is_error: false,
      content: 'ok',
    });

    expect(aggregator.buildDiffs()).toEqual([]);
  });

  it('ignores non-mutation tools', () => {
    const aggregator = new TurnArtifactAggregator(CWD);
    aggregator.observe({
      type: 'tool_started',
      tool_use_id: 'read-1',
      name: 'Read',
      input: { file_path: 'src/app.ts' },
    });
    aggregator.observe({
      type: 'tool_finished',
      tool_use_id: 'read-1',
      is_error: false,
      content: 'content',
    });

    expect(aggregator.flushSummary('session-1')).toBeNull();
  });
});

describe('synthesizeTurnArtifactSummaries', () => {
  it('inserts a session_summary before turn_finished when missing', () => {
    const events = synthesizeTurnArtifactSummaries([
      {
        type: 'user_message',
        session_id: 'session-1',
        content: 'hello',
      },
      {
        type: 'tool_started',
        session_id: 'session-1',
        tool_use_id: 'write-1',
        name: 'Write',
        input: { file_path: 'src/app.ts', content: 'next\n' },
      },
      {
        type: 'tool_finished',
        session_id: 'session-1',
        tool_use_id: 'write-1',
        is_error: false,
        content: 'ok',
      },
      {
        type: 'turn_finished',
        session_id: 'session-1',
        outcome: 'interrupted',
      },
    ], CWD);

    const summaryIndex = events.findIndex((event) => event.subtype === 'session_summary');
    const turnFinishedIndex = events.findIndex((event) => event.type === 'turn_finished');
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(turnFinishedIndex);
  });
});

describe('isArtifactPathInWorkspace', () => {
  it('accepts relative paths inside the cwd', () => {
    expect(isArtifactPathInWorkspace(CWD, 'src/app.ts')).toBe(true);
    expect(isArtifactPathInWorkspace(CWD, `${CWD}/src/app.ts`)).toBe(true);
  });

  it('rejects paths outside the cwd', () => {
    expect(isArtifactPathInWorkspace(CWD, 'D:/other/project/outside.ts')).toBe(false);
    expect(isArtifactPathInWorkspace(CWD, '../outside.ts')).toBe(false);
  });
});
