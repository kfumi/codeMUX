import { beforeEach, describe, expect, it } from 'vitest';

import {
  activityGroupScopeKey,
  readActivityGroupDisclosure,
  resolveActivityRunOpen,
  useActivityGroupStore,
} from './activityGroupStore';

describe('activityGroupStore', () => {
  beforeEach(() => {
    useActivityGroupStore.setState({ openByKey: {} });
  });

  it('默认未接管：读取返回折叠且未接管', () => {
    expect(readActivityGroupDisclosure({}, 's1', 'turn-1-3')).toEqual({ claimed: false, open: false });
  });

  it('setRunOpen 写入即接管；重复写同值不换引用', () => {
    const { setRunOpen } = useActivityGroupStore.getState();
    setRunOpen('s1', 'turn-1-3', true);

    const state = useActivityGroupStore.getState();
    expect(readActivityGroupDisclosure(state.openByKey, 's1', 'turn-1-3')).toEqual({ claimed: true, open: true });

    // 同值写入不产生新对象：订阅方（行比较器）不该被无关刷新唤醒。
    const before = state.openByKey;
    useActivityGroupStore.getState().setRunOpen('s1', 'turn-1-3', true);
    expect(useActivityGroupStore.getState().openByKey).toBe(before);
  });

  it('作用域键隔离主会话与子智能体轨道，也隔离不同会话', () => {
    expect(activityGroupScopeKey('s1')).toBe('s1');
    expect(activityGroupScopeKey('s1', 'sub-1')).toBe('s1::sub-1');

    const { setRunOpen } = useActivityGroupStore.getState();
    setRunOpen('s1', 'run-1', true);
    setRunOpen('s1::sub-1', 'run-1', false);
    setRunOpen('s2', 'run-1', true);

    const { openByKey } = useActivityGroupStore.getState();
    expect(readActivityGroupDisclosure(openByKey, 's1', 'run-1').open).toBe(true);
    expect(readActivityGroupDisclosure(openByKey, 's1::sub-1', 'run-1').open).toBe(false);
    expect(readActivityGroupDisclosure(openByKey, 's2', 'run-1').open).toBe(true);
  });

  it('pruneScope 只清理该会话（含其子智能体轨道）的条目', () => {
    const { setRunOpen } = useActivityGroupStore.getState();
    setRunOpen('s1', 'run-1', true);
    setRunOpen('s1::sub-1', 'run-2', true);
    setRunOpen('s2', 'run-3', true);

    useActivityGroupStore.getState().pruneScope('s1');

    const { openByKey } = useActivityGroupStore.getState();
    expect(openByKey['s1:run-1']).toBeUndefined();
    expect(openByKey['s1::sub-1:run-2']).toBeUndefined();
    expect(openByKey['s2:run-3']).toBe(true);
  });

  it('没有条目可清理时不产生新引用', () => {
    const { setRunOpen } = useActivityGroupStore.getState();
    setRunOpen('s2', 'run-3', true);
    const before = useActivityGroupStore.getState().openByKey;

    useActivityGroupStore.getState().pruneScope('s1');

    expect(useActivityGroupStore.getState().openByKey).toBe(before);
  });
});

describe('resolveActivityRunOpen', () => {
  it('接管的组完全由用户说了算', () => {
    expect(resolveActivityRunOpen({ claimed: true, open: true }, { delegation: false, live: false }, false)).toBe(true);
    expect(resolveActivityRunOpen({ claimed: true, open: false }, { delegation: false, live: true }, false)).toBe(false);
    expect(resolveActivityRunOpen({ claimed: true, open: false }, { delegation: true, live: true }, true)).toBe(false);
  });

  it('委派段维持旧行为：运行中默认展开，结束后收起', () => {
    expect(resolveActivityRunOpen({ claimed: false, open: false }, { delegation: true, live: true }, false)).toBe(true);
    expect(resolveActivityRunOpen({ claimed: false, open: false }, { delegation: true, live: false }, true)).toBe(true);
    expect(resolveActivityRunOpen({ claimed: false, open: false }, { delegation: true, live: false }, false)).toBe(false);
  });

  it('普通段一律默认折叠（实时、历史、失败都一样）', () => {
    expect(resolveActivityRunOpen({ claimed: false, open: false }, { delegation: false, live: true }, false)).toBe(false);
    expect(resolveActivityRunOpen({ claimed: false, open: false }, { delegation: false, live: false }, false)).toBe(false);
  });

  it('没有段时步骤恒可见', () => {
    expect(resolveActivityRunOpen({ claimed: false, open: false }, null, false)).toBe(true);
  });
});
