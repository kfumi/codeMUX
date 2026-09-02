import type { BrowserControlSettings } from '../types/provider';

export type { BrowserControlSettings };

export function normalizeBrowserControl(
  value?: Partial<BrowserControlSettings> | null,
): BrowserControlSettings {
  return {
    enabled: value?.enabled ?? false,
    ignore_certificate_errors: value?.ignore_certificate_errors ?? false,
  };
}
