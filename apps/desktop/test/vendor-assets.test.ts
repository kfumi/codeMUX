import { describe, expect, it } from 'vitest';

import { isVendorAssetPath, VENDOR_ASSET_PREFIX } from '../src/vendor-assets';

describe('isVendorAssetPath', () => {
  it('命中 vendor 目录本身与目录下的资源', () => {
    expect(isVendorAssetPath('vs')).toBe(true);
    expect(isVendorAssetPath('vs/loader.js')).toBe(true);
    expect(isVendorAssetPath('vs/assets/ts.worker-BWKtMYOk.js')).toBe(true);
    expect(isVendorAssetPath('vs/language/typescript/ts.worker.js')).toBe(true);
  });

  it('只认路径边界，不误伤同前缀的普通文件', () => {
    // 这些都是应用自己的文件，缺失时必须继续走 SPA 回退。
    expect(isVendorAssetPath('vsconfig.js')).toBe(false);
    expect(isVendorAssetPath('vslang.js')).toBe(false);
    expect(isVendorAssetPath('assets/app.js')).toBe(false);
    expect(isVendorAssetPath('index.html')).toBe(false);
    expect(isVendorAssetPath('')).toBe(false);
  });

  it('前缀常量与实际判定保持一致', () => {
    expect(VENDOR_ASSET_PREFIX).toBe('vs/');
    expect(isVendorAssetPath(`${VENDOR_ASSET_PREFIX}editor/editor.main.js`)).toBe(true);
  });
});
