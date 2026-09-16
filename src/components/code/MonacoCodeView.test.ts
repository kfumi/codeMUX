import { describe, expect, it } from 'vitest';

import { monacoModelPath } from './MonacoCodeView';

describe('monacoModelPath', () => {
  it('把路径规整成 Monaco 可解析的 URI', () => {
    expect(monacoModelPath('/repo/src/app.ts')).toBe('file:///repo/src/app.ts');
  });

  it('反斜杠的 Windows 路径归一成正斜杠(否则会被当成 scheme)', () => {
    expect(monacoModelPath('C:\\repo\\src\\app.ts')).toBe('file:///C:/repo/src/app.ts');
  });

  it('没有路径时返回 undefined，交给 Monaco 用默认模型', () => {
    expect(monacoModelPath()).toBeUndefined();
    expect(monacoModelPath('')).toBeUndefined();
    expect(monacoModelPath('/')).toBeUndefined();
  });

  it('结果稳定,且不同盘符不会被合并成同一个模型', () => {
    expect(monacoModelPath('/repo/a.ts')).toBe(monacoModelPath('/repo/a.ts'));
    expect(monacoModelPath('C:\\repo\\a.ts')).toBe('file:///C:/repo/a.ts');
    // 盘符必须保留:C:\repo\a.ts 与 D:\repo\a.ts 是两个不同的文件。
    expect(monacoModelPath('C:\\repo\\a.ts')).not.toBe(monacoModelPath('D:\\repo\\a.ts'));
  });
});
