// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderBrandIcon, providerBrandMeta } from './ProviderBrandIcon';

describe('ProviderBrandIcon', () => {
  it('maps the opencode brand key to the OpenCode logo', () => {
    const meta = providerBrandMeta('opencode');
    expect(meta.label).toBe('OpenCode');
    expect(meta.svg).toBeTruthy();
  });

  it('keeps the opencode-go template on the OpenCode logo', () => {
    expect(providerBrandMeta('opencode-go').svg).toBeTruthy();
  });

  it('falls back to a letter avatar for unknown brands', () => {
    const { container } = render(
      <ProviderBrandIcon templateId={null} name="OpenCode 免费模型" />,
    );
    // 无 svg 且 name 有值:取首字母,而不是 OpenCode logo。
    expect(container.textContent).toBe('O');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the OpenCode logo svg for the opencode brand', () => {
    const { container } = render(<ProviderBrandIcon templateId="opencode" name="OpenCode" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
