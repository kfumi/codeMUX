import { describe, expect, it } from 'vitest';

import { resolveMonacoLanguage } from './monacoLanguage';

describe('resolveMonacoLanguage', () => {
  it('按扩展名映射到 Monaco 真实存在的语言 id', () => {
    expect(resolveMonacoLanguage('/repo/src/app.ts')).toBe('typescript');
    expect(resolveMonacoLanguage('/repo/src/app.tsx')).toBe('typescript');
    expect(resolveMonacoLanguage('/repo/src/main.rs')).toBe('rust');
    expect(resolveMonacoLanguage('/repo/scripts/run.sh')).toBe('shell');
    expect(resolveMonacoLanguage('/repo/data.json')).toBe('json');
    expect(resolveMonacoLanguage('/repo/style.scss')).toBe('scss');
    expect(resolveMonacoLanguage('/repo/page.html')).toBe('html');
    expect(resolveMonacoLanguage('/repo/Cargo.toml')).toBe('ini');
  });

  it('接受 Windows 反斜杠路径', () => {
    expect(resolveMonacoLanguage('C:\\repo\\src\\app.py')).toBe('python');
    expect(resolveMonacoLanguage('C:\\repo\\Dockerfile')).toBe('dockerfile');
  });

  it('识别无扩展名的已知文件名', () => {
    expect(resolveMonacoLanguage('/repo/Dockerfile')).toBe('dockerfile');
    expect(resolveMonacoLanguage('/repo/Containerfile')).toBe('dockerfile');
    expect(resolveMonacoLanguage('/home/me/.bashrc')).toBe('shell');
    expect(resolveMonacoLanguage('/home/me/.zshrc')).toBe('shell');
  });

  it('识别不了时退回 plaintext，而不是返回空', () => {
    // 空值与无扩展名文件
    expect(resolveMonacoLanguage()).toBe('plaintext');
    expect(resolveMonacoLanguage(null)).toBe('plaintext');
    expect(resolveMonacoLanguage('')).toBe('plaintext');
    expect(resolveMonacoLanguage('/repo/LICENSE')).toBe('plaintext');
    // 以点开头的隐藏文件不能被当成扩展名
    expect(resolveMonacoLanguage('/repo/.gitignore')).toBe('plaintext');
    // Monaco 没有对应语言的文件类型
    expect(resolveMonacoLanguage('/repo/App.vue')).toBe('plaintext');
    expect(resolveMonacoLanguage('/repo/App.svelte')).toBe('plaintext');
  });

  it('大小写不敏感', () => {
    expect(resolveMonacoLanguage('/repo/SRC/App.TS')).toBe('typescript');
    expect(resolveMonacoLanguage('/repo/DOCKERFILE')).toBe('dockerfile');
  });
});
