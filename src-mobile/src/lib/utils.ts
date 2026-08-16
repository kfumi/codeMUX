import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      // HTTP / non-secure contexts may expose crypto without randomUUID.
    }
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function detectBrowser(userAgent: string): string | null {
  if (/MicroMessenger/i.test(userAgent)) return '微信';
  if (/CriOS\//.test(userAgent) || (/Chrome\//.test(userAgent) && !/Edg\//.test(userAgent) && !/OPR\//.test(userAgent))) {
    return 'Chrome';
  }
  if (/FxiOS\//.test(userAgent) || /Firefox\//.test(userAgent)) return 'Firefox';
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return null;
}

export function suggestDeviceName(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (!userAgent) return '移动设备';

  let device = '移动设备';
  if (/iPhone/.test(userAgent)) device = 'iPhone';
  else if (/iPad/.test(userAgent)) device = 'iPad';
  else if (/iPod/.test(userAgent)) device = 'iPod';
  else {
    const android = userAgent.match(/Android[^;]*;\s*([^)]+)\)/);
    if (android) device = android[1].trim();
  }

  const browser = detectBrowser(userAgent);
  return browser ? `${device} · ${browser}` : device;
}
