// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Streamdown } from 'streamdown';

import { CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS, encodeLocalImageSrcForSanitize } from './markdown-link';
import { CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS } from './markdown-text';
import {
  clearMarkdownImageCache,
  CodeMuxMarkdownImage,
  MarkdownImageDocumentProvider,
  resolveMarkdownImageAbsolutePath,
} from './markdown-image';

const previewImageFile = vi.fn();
const DATA_URL = 'data:image/png;base64,AAAA';

vi.mock('@/lib/facades/daemon-facade', () => ({
  daemonFacade: {
    previewImageFile: (...args: unknown[]) => previewImageFile(...args),
  },
}));

describe('resolveMarkdownImageAbsolutePath', () => {
  it('resolves a bare relative path against the markdown file directory', () => {
    expect(
      resolveMarkdownImageAbsolutePath('public/demo/home.png', {
        documentPath: 'D:/project/ai-code/codeMUX/README.md',
      }),
    ).toBe('D:/project/ai-code/codeMUX/public/demo/home.png');
  });

  it('resolves the sanitize-safe fake origin written by the rehype plugin', () => {
    expect(
      resolveMarkdownImageAbsolutePath(
        encodeLocalImageSrcForSanitize('public/demo/home.png'),
        { documentPath: 'D:/project/ai-code/codeMUX/README.md' },
      ),
    ).toBe('D:/project/ai-code/codeMUX/public/demo/home.png');
  });

  it('normalizes ./ and ../ segments and Windows separators', () => {
    expect(
      resolveMarkdownImageAbsolutePath('./img\\shot.png', {
        documentPath: 'D:/project/ai-code/codeMUX/docs/notes.md',
      }),
    ).toBe('D:/project/ai-code/codeMUX/docs/img/shot.png');

    expect(
      resolveMarkdownImageAbsolutePath('../assets/shot.png', {
        documentPath: 'D:/project/ai-code/codeMUX/docs/notes.md',
      }),
    ).toBe('D:/project/ai-code/codeMUX/assets/shot.png');
  });

  it('keeps absolute local paths and file:// urls usable without a document', () => {
    expect(resolveMarkdownImageAbsolutePath('D:/shots/a.png', null)).toBe('D:/shots/a.png');
    expect(resolveMarkdownImageAbsolutePath('file:///D:/shots/a.png', null)).toBe('D:/shots/a.png');
  });

  it('leaves remote and inline sources to the browser', () => {
    expect(
      resolveMarkdownImageAbsolutePath('https://example.com/a.png', {
        documentPath: 'D:/project/ai-code/codeMUX/README.md',
      }),
    ).toBeNull();
    expect(
      resolveMarkdownImageAbsolutePath('data:image/png;base64,AAAA', {
        documentPath: 'D:/project/ai-code/codeMUX/README.md',
      }),
    ).toBeNull();
  });

  it('uses the project root when the document path itself is relative', () => {
    expect(
      resolveMarkdownImageAbsolutePath('public/demo/home.png', {
        documentPath: 'README.md',
        basePath: 'D:/project/ai-code/codeMUX',
      }),
    ).toBe('D:/project/ai-code/codeMUX/public/demo/home.png');
  });
});

describe('CodeMuxMarkdownImage', () => {
  beforeEach(() => {
    previewImageFile.mockReset();
    clearMarkdownImageCache();
  });

  it('renders a local image through the daemon image preview endpoint', async () => {
    previewImageFile.mockResolvedValue(DATA_URL);

    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <CodeMuxMarkdownImage
          alt="首页"
          src={encodeLocalImageSrcForSanitize('public/demo/home.png')}
        />
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA_URL);
    });
    expect(previewImageFile).toHaveBeenCalledWith(
      'D:/project/ai-code/codeMUX/public/demo/home.png',
    );
    expect(screen.getByAltText('首页')).toBeTruthy();
  });

  it('falls back to the alt text when the image cannot be read', async () => {
    previewImageFile.mockRejectedValue(new Error('图片超过 8 MiB 预览上限'));

    render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <CodeMuxMarkdownImage
          alt="首页"
          src={encodeLocalImageSrcForSanitize('public/demo/home.png')}
        />
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('markdown-image-error').textContent).toContain('首页');
    });
  });

  it('keeps remote images untouched without asking the daemon', () => {
    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <CodeMuxMarkdownImage alt="远端" src="https://example.com/logo.png" />
      </MarkdownImageDocumentProvider>,
    );

    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/logo.png');
    expect(previewImageFile).not.toHaveBeenCalled();
  });
});

describe('文件预览管线的相对图片', () => {
  beforeEach(() => {
    previewImageFile.mockReset();
    clearMarkdownImageCache();
  });

  it('renders relative markdown images instead of the harden placeholder', async () => {
    previewImageFile.mockResolvedValue(DATA_URL);

    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <Streamdown
          mode="static"
          components={CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS.components}
          rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
          linkSafety={{ enabled: false }}
        >
          {'![AI 过程与工具卡片](public/demo/tools.png)'}
        </Streamdown>
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA_URL);
    });
    expect(container.textContent).not.toContain('Image blocked');
    expect(previewImageFile).toHaveBeenCalledWith(
      'D:/project/ai-code/codeMUX/public/demo/tools.png',
    );
  });

  it('keeps remote markdown images on the browser path', async () => {
    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <Streamdown
          mode="static"
          components={CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS.components}
          rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
          linkSafety={{ enabled: false }}
        >
          {'![远端](https://example.com/logo.png)'}
        </Streamdown>
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/logo.png',
      );
    });
    expect(previewImageFile).not.toHaveBeenCalled();
  });
});

describe('文件预览管线的裸 HTML 图片', () => {
  beforeEach(() => {
    previewImageFile.mockReset();
    clearMarkdownImageCache();
  });

  // 裸 HTML `<img>`（README 顶部的 Logo）只有 rehype-raw 跑完才成为 img 元素，
  // 因此本地图片改写必须排在 rehype-raw 之后，否则 harden 仍会把它换成
  // `[Image blocked: ...]`。
  it('rewrites relative raw-HTML images as well', async () => {
    previewImageFile.mockResolvedValue(DATA_URL);

    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <Streamdown
          mode="static"
          components={CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS.components}
          rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
          linkSafety={{ enabled: false }}
        >
          {'<p align="center"><img src="crates/daemon/icons/128x128@2x.png" width="120" alt="CodeMUX Logo"></p>'}
        </Streamdown>
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA_URL);
    });
    expect(container.textContent).not.toContain('Image blocked');
    expect(previewImageFile).toHaveBeenCalledWith(
      'D:/project/ai-code/codeMUX/crates/daemon/icons/128x128@2x.png',
    );
  });
});

describe('本地图片地址的后缀处理', () => {
  it('drops #fragment and ?query before reading the file', () => {
    expect(
      resolveMarkdownImageAbsolutePath('logo-dark.png#gh-dark-mode-only', {
        documentPath: 'D:/project/ai-code/codeMUX/README.md',
      }),
    ).toBe('D:/project/ai-code/codeMUX/logo-dark.png');

    expect(
      resolveMarkdownImageAbsolutePath('logo.png?v=3', {
        documentPath: 'D:/project/ai-code/codeMUX/README.md',
      }),
    ).toBe('D:/project/ai-code/codeMUX/logo.png');
  });
});

describe('图片地址缺失或无法解析', () => {
  beforeEach(() => {
    previewImageFile.mockReset();
    clearMarkdownImageCache();
  });

  it('renders nothing when the src is gone (sanitize strips data: urls)', () => {
    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <CodeMuxMarkdownImage alt="内联图" />
      </MarkdownImageDocumentProvider>,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-image-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-image-error"]')).toBeNull();
  });

  it('does not leave a stuck placeholder for inline data: images in previews', async () => {
    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <Streamdown
          mode="static"
          components={CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS.components}
          rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
          linkSafety={{ enabled: false }}
        >
          {'![内联图](data:image/png;base64,AAAA)'}
        </Streamdown>
      </MarkdownImageDocumentProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[data-testid="markdown-image-loading"]')).toBeNull();
  });

  it('shows the fallback instead of a bogus image when the base directory is unknown', () => {
    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="">
        <CodeMuxMarkdownImage
          alt="无基准"
          src={encodeLocalImageSrcForSanitize('public/demo/home.png')}
        />
      </MarkdownImageDocumentProvider>,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="markdown-image-error"]')?.textContent).toContain('无基准');
    expect(previewImageFile).not.toHaveBeenCalled();
  });

  it('keeps #fragment and ?query suffixes out of the file path through the whole pipeline', async () => {
    previewImageFile.mockResolvedValue(DATA_URL);

    const { container } = render(
      <MarkdownImageDocumentProvider documentPath="D:/project/ai-code/codeMUX/README.md">
        <Streamdown
          mode="static"
          components={CODEMUX_FILE_PREVIEW_STREAMDOWN_PROPS.components}
          rehypePlugins={CODEMUX_FILE_PREVIEW_REHYPE_PLUGINS}
          linkSafety={{ enabled: false }}
        >
          {'![暗色](public/demo/tools.png#gh-dark-mode-only)'}
        </Streamdown>
      </MarkdownImageDocumentProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(DATA_URL);
    });
    expect(previewImageFile).toHaveBeenCalledWith(
      'D:/project/ai-code/codeMUX/public/demo/tools.png',
    );
  });
});
