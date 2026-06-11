import { createCodexCompatProxyServer, type ProxyServerHandle } from './codexCompatProxy.js';
import { shouldUseCodexChatCompatProxy } from './sessionRuntimeHelpers.js';

type ProxyConfig = {
  apiKey: string;
  baseUrl: string;
};

export type ProxyStatus = {
  running: boolean;
  port: number | null;
  upstreamBaseUrl: string | null;
};

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

    await this.stop();

    this.proxy = await createCodexCompatProxyServer(newConfig);
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

  private extractPort(baseUrl: string): number {
    try {
      return new URL(baseUrl).port ? Number(new URL(baseUrl).port) : 0;
    } catch {
      return 0;
    }
  }
}

export const proxyManager = new ProxyManager();
