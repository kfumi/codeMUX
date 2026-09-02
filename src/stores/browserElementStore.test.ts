import { beforeEach, describe, expect, it } from 'vitest';

import { consumeBrowserElementsForSend, useBrowserElementStore } from './browserElementStore';

describe('browser element store', () => {
  beforeEach(() => {
    useBrowserElementStore.getState().reset();
  });

  it('keeps captured elements isolated by session', () => {
    useBrowserElementStore.getState().add('session-a', {
      url: 'https://example.com/',
      tag: 'div',
      text: 'nav',
    });
    useBrowserElementStore.getState().add('session-b', {
      url: 'https://example.com/',
      tag: 'button',
      text: 'go',
    });

    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toHaveLength(1);
    expect(useBrowserElementStore.getState().elementsBySession['session-b'][0].tag).toBe('button');
  });

  it('can remove one element and clear the rest', () => {
    const store = useBrowserElementStore.getState();
    store.add('session-a', { url: 'https://example.com/', tag: 'div', text: 'one' });
    store.add('session-a', { url: 'https://example.com/', tag: 'span', text: 'two' });
    const firstId = useBrowserElementStore.getState().elementsBySession['session-a'][0].id;

    useBrowserElementStore.getState().remove('session-a', firstId);
    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toHaveLength(1);

    useBrowserElementStore.getState().clear('session-a');
    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toEqual([]);
  });

  it('merges consumed elements into the user message text and clears the draft', () => {
    useBrowserElementStore.getState().add('session-a', {
      url: 'https://www.baidu.com/',
      tag: 'div',
      text: '新闻 hao123',
    });

    const payload = consumeBrowserElementsForSend('session-a', { text: '看下这个导航' });
    expect(payload.text).toContain('<browser-element url="https://www.baidu.com/">');
    expect(payload.text).toContain('<text>新闻 hao123</text>');
    expect(useBrowserElementStore.getState().elementsBySession['session-a']).toEqual([]);
  });
});
