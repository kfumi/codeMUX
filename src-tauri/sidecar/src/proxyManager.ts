import { createCodexCompatProxyServer, type ProxyServerHandle } from './codexCompatProxy.js';
import { shouldUseCodexChatCompatProxy } from './sessionRuntimeHelpers.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type ProxyConfig = {
  apiKey: string;
  baseUrl: string;
};

export type ProxyStatus = {
  running: boolean;
  port: number | null;
  upstreamBaseUrl: string | null;
};

const execFileAsync = promisify(execFile);
const COMPAT_PROXY_PORT = 15722;
const COMPAT_PROXY_BASE_URL = `http://127.0.0.1:${COMPAT_PROXY_PORT}`;
const COMPAT_PROXY_HEALTH_URL = `${COMPAT_PROXY_BASE_URL}/__codemux_proxy_health`;
const COMPAT_PROXY_SHUTDOWN_URL = `${COMPAT_PROXY_BASE_URL}/__codemux_proxy_shutdown`;

class ProxyManager {
  private proxy: ProxyServerHandle | null = null;
  private config: ProxyConfig | null = null;

  /**
   * Start the compat proxy. If already running with the same config, returns existing port.
   * If config changed, stops the old proxy and starts a new one.
   * Returns null if the baseUrl doesn't need a proxy (i.e. it's api.openai.com).
   */
  async start(apiKey: string, baseUrl: string): Promise<{ port: number } | null> {
    if (!shouldUseCodexChatCompatProxy(baseUrl)) {
      process.stderr.write('[proxy-manager] Proxy not needed for this provider\n');
      return null;
    }

    const newConfig: ProxyConfig = { apiKey, baseUrl };
    const configFingerprint = JSON.stringify(newConfig);

    if (this.proxy && this.config && JSON.stringify(this.config) === configFingerprint) {
      const port = this.extractPort(this.proxy.baseUrl);
      process.stderr.write(`[proxy-manager] Proxy already running on port ${port}\n`);
      return { port };
    }

    const reused = await this.tryReuseExistingProxy(newConfig);
    if (reused) {
      return { port: COMPAT_PROXY_PORT };
    }

    await this.stop();

    try {
      this.proxy = await createCodexCompatProxyServer(newConfig);
    } catch (error) {
      if (isAddressInUseError(error)) {
        const reclaimed = await this.forceRestartPortOwner();
        if (reclaimed) {
          this.proxy = await createCodexCompatProxyServer(newConfig);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    this.config = newConfig;
    const port = this.extractPort(this.proxy.baseUrl);
    process.stderr.write(`[proxy-manager] Proxy started on port ${port}, upstream=${baseUrl}\n`);
    return { port };
  }

  async stop(): Promise<void> {
    if (!this.proxy) {
      return;
    }
    try {
      await this.proxy.close();
      process.stderr.write('[proxy-manager] Proxy stopped\n');
    } catch (error) {
      process.stderr.write(`[proxy-manager] Error stopping proxy: ${error}\n`);
    }
    this.proxy = null;
    this.config = null;
  }

  getStatus(): ProxyStatus {
    return {
      running: !!this.proxy,
      port: this.proxy ? this.extractPort(this.proxy.baseUrl) : null,
      upstreamBaseUrl: this.config?.baseUrl ?? null,
    };
  }

  getBaseUrl(): string | null {
    return this.proxy?.baseUrl ?? null;
  }

  private async tryReuseExistingProxy(config: ProxyConfig): Promise<boolean> {
    try {
      const response = await fetch(COMPAT_PROXY_HEALTH_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        return false;
      }

      this.proxy = {
        baseUrl: COMPAT_PROXY_BASE_URL,
        close: async () => {
          await fetch(COMPAT_PROXY_SHUTDOWN_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          }).catch(() => {});
        },
      };
      this.config = config;
      process.stderr.write(`[proxy-manager] Reusing existing proxy on port ${COMPAT_PROXY_PORT}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private async forceRestartPortOwner(): Promise<boolean> {
    if (process.platform !== 'win32') {
      return false;
    }

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${COMPAT_PROXY_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
      ]);
      const pids = stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== '0');

      if (pids.length === 0) {
        return false;
      }

      for (const pid of pids) {
        await execFileAsync('taskkill.exe', ['/PID', pid, '/F']);
        process.stderr.write(`[proxy-manager] Killed process ${pid} occupying port ${COMPAT_PROXY_PORT}\n`);
      }

      return true;
    } catch (error) {
      process.stderr.write(`[proxy-manager] Failed to reclaim port ${COMPAT_PROXY_PORT}: ${error}\n`);
      return false;
    }
  }

  private extractPort(baseUrl: string): number {
    try {
      return new URL(baseUrl).port ? Number(new URL(baseUrl).port) : 0;
    } catch {
      return 0;
    }
  }
}

export const proxyManager = new ProxyManager();

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && /EADDRINUSE/i.test(error.message);
}
