// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ImageAttachmentPreview } from './ImageAttachmentPreview';

describe('ImageAttachmentPreview', () => {
  afterEach(() => {
    cleanup();
  });

  it('styles the close button for dark preview surfaces in light mode', () => {
    render(<ImageAttachmentPreview src="data:image/png;base64,abc" alt="screen.png" />);

    fireEvent.click(screen.getByRole('button', { name: '预览图片 screen.png' }));

    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton.className).toContain('text-white/85');
    expect(closeButton.className).toContain('data-[state=open]:text-white/85');
  });
});
