/**
 * 统一前端引导单入口(工单 02)。
 *
 * 桥注入不再是一条硬编码路径,而是三种引导策略之一:
 * 1. `shell` —— 桌面壳桥注入 Local Daemon Token(既有桌面行为不变);
 * 2. `paired` —— 浏览器已有配对档案(内容存 localStorage),直接建连;
 * 3. `loopback-pairing` / `remote-pairing` —— 首次访问,走同机简化配对或
 *    跨机配对码/扫码(用户故事 3/4/12)。
 *
 * 桥缺失不再是错误,而是切到浏览器引导的信号;解析结果只描述「用哪个配置
 * 连哪个 daemon」,协议客户端仍然只讲 Companion REST/WS。
 */
import { parsePairingInput, type CompanionConnectionProfile, type CompanionOfferV1, type ParsedPairingInput } from '../companion-connection';
import { buildProfileFromOffer, buildProfileFromPairing } from '../companion-connection';
import { companionHttpRequest } from '../companion-connection';
import { connectionBaseUrl, resolveActiveConnection } from '../companion-connection';
import type { DaemonConnectionConfig } from '../daemon-client/client';
import { desktopBridge } from '../desktop-bridge';
import { detectHostForm, isLoopbackOrigin, readHostEnvironment, type HostForm } from '../host/host-form';
import { createLogger } from '../logger';
import { useDaemonConnectionStore } from '../../stores/daemonConnectionStore';
import { clearStoredProfile, loadStoredProfile, saveStoredProfile } from './connection-storage';
import { awaitLocalPairingApproval, LocalPairingError, requestLocalPairing } from './local-pairing';

const logger = createLogger('daemon-bootstrap');

export type BootstrapTarget = 'shell' | 'paired' | 'loopback-pairing' | 'remote-pairing';

export interface BootstrapTargetInput {
  hasShellBridge: boolean;
  isLoopbackOrigin: boolean;
  hasStoredProfile: boolean;
  hasPairingInput: boolean;
}

/**
 * 引导路径选择(纯函数):壳桥 > 已配对档案 > 携带配对输入的跨机访问 >
 * 同机简化配对 > 跨机手工配对。
 */
export function classifyBootstrapTarget(input: BootstrapTargetInput): BootstrapTarget {
  if (input.hasShellBridge) return 'shell';
  if (input.hasStoredProfile) return 'paired';
  if (input.hasPairingInput) return 'remote-pairing';
  if (input.isLoopbackOrigin) return 'loopback-pairing';
  return 'remote-pairing';
}

/** 没有可用的 daemon 连接时抛出:调用方应展示配对引导而非报错崩溃。 */
export class DaemonConnectionRequiredError extends Error {
  constructor(message = '尚未与 CodeMUX 桌面端配对') {
    super(message);
    this.name = 'DaemonConnectionRequiredError';
  }
}

/** 同机浏览器提示用的人类可读设备名(配对设备列表里能看到)。 */
export function describeBrowserDevice(userAgent?: string | null): string {
  const ua = userAgent ?? '';
  if (!ua) return '浏览器';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '浏览器';
  // iOS UA 里也含 "like Mac OS X",因此移动平台必须先判,再判桌面平台。
  const platform = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return platform ? `${browser} · ${platform}` : browser;
}

function currentPageHref(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.href ?? '';
}

/** URL 里是否携带配对输入(#offer= 或 ?code=)。 */
export function hasPairingInput(href?: string | null): boolean {
  const value = href ?? currentPageHref();
  if (!value) return false;
  return value.includes('#offer=') || /[?&]code=/.test(value);
}

export function currentHostForm(): HostForm {
  return detectHostForm(readHostEnvironment());
}

async function resolveShellBridgeConfig(): Promise<DaemonConnectionConfig> {
  const bridge = desktopBridge;
  if (!bridge) {
    throw new DaemonConnectionRequiredError('codemuxDesktop 桥不可用(Electron preload 未注入)');
  }
  const [token, info] = await Promise.all([bridge.getLocalDaemonToken(), bridge.getDaemonInfo()]);
  if (!info.port) {
    throw new Error('本机 Daemon 未就绪，请稍后重试或重启应用。');
  }
  return { baseUrl: `http://127.0.0.1:${info.port}`, token };
}

/**
 * 档案 → 连接配置。中继连接无法直连,改为经既有中继/E2EE 通道发请求并
 * 用轮询代替 WebSocket(与移动端回退一致)。
 */
export function profileToConnectionConfig(
  profile: CompanionConnectionProfile,
): DaemonConnectionConfig {
  const active = resolveActiveConnection(profile);
  const baseUrl = connectionBaseUrl(active);
  if (active.type === 'relay') {
    return {
      baseUrl,
      token: profile.token,
      polling: true,
      transport: {
        request: (path, init) => companionHttpRequest(profile, path, init, {}),
      },
    };
  }
  return { baseUrl, token: profile.token };
}

/** 协议客户端要用的 daemon 连接配置(壳桥或浏览器档案)。 */
export async function resolveDaemonConnectionConfig(): Promise<DaemonConnectionConfig> {
  const env = readHostEnvironment();
  if (env.hasShellBridge) {
    return resolveShellBridgeConfig();
  }
  const profile = loadStoredProfile();
  if (!profile) {
    throw new DaemonConnectionRequiredError();
  }
  return profileToConnectionConfig(profile);
}

function isAuthFailure(error: unknown): boolean {
  const message = String(error);
  return /invalid token|missing token|401/i.test(message);
}

async function ensureDaemonClientForProfile(
  profile: CompanionConnectionProfile,
): Promise<void> {
  const { daemonFacade } = await import('../facades/daemon-facade');
  logger.debug('Connecting with stored profile', {
    desktopId: profile.desktopId,
    connections: profile.connections.length,
  });
  // 切换档案后必须丢弃旧 client(端口/令牌都可能不同)。
  daemonFacade.resetClient();
  await daemonFacade.ensureClient();
  // 健康检查不需要令牌,这里补一次鉴权探测,及时暴露失效/被撤销的配对。
  await daemonFacade.getBootstrap();
}

/** 桌面壳形态:沿用既有行为,连接失败不阻塞界面(App 有自己的重试/覆盖层)。 */
async function warmShellClient(): Promise<void> {
  try {
    const { daemonFacade } = await import('../facades/daemon-facade');
    await daemonFacade.ensureClient();
    logger.info('Desktop daemon client connected');
  } catch (error) {
    logger.warn('Desktop daemon client not ready', { error: String(error) });
  }
}

/**
 * 浏览器形态:没有可用连接时回到配对引导;令牌失效则清档案重新配对。
 * 返回 true 表示调用方需要自行处理错误展示。
 */
function recoverBrowserWithoutConnection(error: unknown, origin: string | null | undefined): void {
  const store = useDaemonConnectionStore.getState();
  if (isAuthFailure(error)) {
    clearStoredProfile();
    store.setPairingMode(isLoopbackOrigin(origin) ? 'loopback' : 'remote', '配对已失效，请重新配对');
    return;
  }
  store.setError(String(error));
}

export interface BootstrapOptions {
  /** 跳过 URL 配对输入的自动解析(测试/手工重试用)。 */
  ignorePairingInput?: boolean;
}

let bootstrapInFlight: Promise<void> | null = null;

/** 统一引导入口:决定显示完整界面、连接中、还是配对引导。 */
export function bootstrapDaemonConnection(options: BootstrapOptions = {}): Promise<void> {
  // React StrictMode 会双调用挂载副作用;引导带副作用(配对申请会真的落一条
  // 待确认请求),所以并发调用共享同一次执行,失败后清空以便重试。
  if (!bootstrapInFlight) {
    bootstrapInFlight = runBootstrapDaemonConnection(options).finally(() => {
      bootstrapInFlight = null;
    });
  }
  return bootstrapInFlight;
}

async function runBootstrapDaemonConnection(options: BootstrapOptions): Promise<void> {
  const env = readHostEnvironment();
  const hostForm = detectHostForm(env);
  const store = useDaemonConnectionStore.getState();
  store.begin(hostForm);
  store.setConnecting();

  const profile = env.hasShellBridge ? null : loadStoredProfile();
  const carryPairingInput = !options.ignorePairingInput && hasPairingInput();
  const target = classifyBootstrapTarget({
    hasShellBridge: env.hasShellBridge,
    isLoopbackOrigin: isLoopbackOrigin(env.origin),
    hasStoredProfile: Boolean(profile),
    hasPairingInput: carryPairingInput,
  });

  if (target === 'shell') {
    useDaemonConnectionStore.getState().setConnected('shell-bridge');
    void warmShellClient();
    return;
  }

  if (target === 'paired' && profile) {
    try {
      await ensureDaemonClientForProfile(profile);
      useDaemonConnectionStore.getState().setConnected('paired-browser');
    } catch (error) {
      logger.warn('Stored browser connection failed', { error: String(error) });
      recoverBrowserWithoutConnection(error, env.origin);
    }
    return;
  }

  if (target === 'remote-pairing' && carryPairingInput) {
    try {
      const parsed = parsePairingInput(currentPageHref(), env.origin ?? undefined);
      await completeRemotePairing(parsed, describeBrowserDevice());
      clearPairingInputFromUrl();
    } catch (error) {
      logger.warn('Pairing link failed', { error: String(error) });
      useDaemonConnectionStore.getState().setPairingMode('remote', String(error));
    }
    return;
  }

  useDaemonConnectionStore.getState().setPairingMode(
    isLoopbackOrigin(env.origin) ? 'loopback' : 'remote',
  );
}

/**
 * 去掉地址栏里的配对输入(`#offer=` 片段与 `?code=`/`?host=`/`?port=` 查询),
 * 避免刷新时重复 claim。纯函数,便于断言。
 */
export function stripPairingInputFromUrl(href: string): string {
  const url = new URL(href);
  if (url.hash.includes('offer=')) {
    url.hash = '';
  }
  url.searchParams.delete('code');
  url.searchParams.delete('host');
  url.searchParams.delete('port');
  return url.toString();
}

/** 扫码/链接配对成功后把配对输入从地址栏摘掉。 */
function clearPairingInputFromUrl(): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  let cleaned: string;
  try {
    cleaned = stripPairingInputFromUrl(window.location.href);
  } catch {
    return;
  }
  try {
    window.history.replaceState({}, '', cleaned);
  } catch {
    // ignore
  }
}

function relayClaimProfile(offer: CompanionOfferV1): CompanionConnectionProfile {
  return {
    desktopId: offer.desktopId,
    deviceId: '',
    token: '',
    connections: [{
      id: `relay:${offer.desktopId}`,
      type: 'relay',
      endpoint: offer.relay!.endpoint,
      useTls: offer.relay!.useTls ?? false,
      desktopPublicKeyB64: offer.desktopPublicKeyB64!,
    }],
  };
}

function authHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' };
}

async function claimDirect(
  baseUrl: string,
  code: string,
  name: string,
): Promise<{ token: string; deviceId: string }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/pair/claim`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ code, name }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text.trim() || `配对失败(${response.status})`);
  }
  return response.json() as Promise<{ token: string; deviceId: string }>;
}

async function claimViaRelay(
  offer: CompanionOfferV1,
  code: string,
  name: string,
): Promise<{ token: string; deviceId: string }> {
  const profile = relayClaimProfile(offer);
  const response = await companionHttpRequest(profile, '/api/pair/claim', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ code, name }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.body.trim() || `配对失败(${response.status})`);
  }
  return JSON.parse(response.body) as { token: string; deviceId: string };
}

/** 手工配对码/链接的解析:返回 claim 所需的地址与配对码。 */
export function resolveRemotePairingInput(input: {
  link?: string;
  code?: string;
  baseUrl?: string;
  pageOrigin?: string;
}): ParsedPairingInput {
  if (input.link?.trim()) {
    return parsePairingInput(input.link, input.pageOrigin);
  }
  const code = input.code?.trim();
  if (!code) {
    throw new Error('请输入配对码或粘贴配对链接');
  }
  const baseUrl = input.baseUrl?.trim() || input.pageOrigin?.trim();
  if (!baseUrl) {
    throw new Error('请输入桌面端地址，例如 192.168.1.8:9240');
  }
  const normalized = /^https?:\/\//.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  return { baseUrl: normalized.replace(/\/$/, ''), pairingCode: code };
}

/** claim + 落档案 + 建连。 */
export async function completeRemotePairing(
  parsed: ParsedPairingInput,
  deviceName: string,
): Promise<void> {
  let claim: { token: string; deviceId: string };
  try {
    claim = await claimDirect(parsed.baseUrl, parsed.pairingCode, deviceName);
  } catch (error) {
    // 直连失败(https 页面调 http / 跨网)且 offer 带中继:改走中继通道。
    const relay = parsed.offer?.relay;
    if (!relay || !parsed.offer?.desktopPublicKeyB64) {
      throw error;
    }
    claim = await claimViaRelay(parsed.offer, parsed.pairingCode, deviceName);
  }

  const profile = parsed.offer
    ? buildProfileFromOffer({
        offer: parsed.offer,
        baseUrl: parsed.baseUrl,
        deviceId: claim.deviceId,
        token: claim.token,
        label: deviceName,
      })
    : buildProfileFromPairing({
        desktopId: parsed.desktopId ?? `lan:${parsed.baseUrl}`,
        deviceId: claim.deviceId,
        token: claim.token,
        baseUrl: parsed.baseUrl,
        label: deviceName,
      });

  saveStoredProfile(profile);
  await ensureDaemonClientForProfile(profile);
  useDaemonConnectionStore.getState().setConnected('paired-browser');
}

/** 同机浏览器:申请配对 → 等桌面壳/CLI 确认 → 拿到 Pairing Token。 */
export async function startLoopbackPairing(): Promise<void> {
  const env = readHostEnvironment();
  const origin = env.origin;
  if (!origin) {
    useDaemonConnectionStore.getState().setPairingFailure('当前环境无法确定为回环来源');
    return;
  }
  const deviceName = describeBrowserDevice(env.userAgent);
  try {
    const started = await requestLocalPairing(origin, deviceName);
    useDaemonConnectionStore.getState().setPairingWaiting({
      requestId: started.requestId,
      code: started.code,
      expiresAt: started.expiresAt,
      desktopId: started.desktopId,
    });
    const approved = await awaitLocalPairingApproval(origin, started.requestId);
    const profile = buildProfileFromPairing({
      desktopId: approved.desktopId || origin,
      deviceId: approved.deviceId,
      token: approved.token,
      baseUrl: origin,
      label: deviceName,
    });
    saveStoredProfile(profile);
    await ensureDaemonClientForProfile(profile);
    useDaemonConnectionStore.getState().setConnected('loopback-browser');
  } catch (error) {
    const message = error instanceof LocalPairingError ? error.message : String(error);
    logger.warn('Loopback pairing failed', { error: message });
    useDaemonConnectionStore.getState().setPairingFailure(message);
  }
}

/** 跨机浏览器:手工配对码/粘贴链接。 */
export async function submitRemotePairing(input: {
  link?: string;
  code?: string;
  baseUrl?: string;
}): Promise<void> {
  const env = readHostEnvironment();
  const store = useDaemonConnectionStore.getState();
  store.setPairingClaiming('remote');
  try {
    const parsed = resolveRemotePairingInput({ ...input, pageOrigin: env.origin ?? undefined });
    await completeRemotePairing(parsed, describeBrowserDevice(env.userAgent));
  } catch (error) {
    logger.warn('Remote pairing failed', { error: String(error) });
    useDaemonConnectionStore.getState().setPairingFailure(String(error));
  }
}

/** 退出当前浏览器配对(设置页/调试入口)。 */
export function disconnectBrowserConnection(): void {
  clearStoredProfile();
  void import('../facades/daemon-facade').then(({ daemonFacade }) => daemonFacade.resetClient());
  useDaemonConnectionStore.getState().reset();
}

export function getDaemonStartupError(): string | null {
  const { status, error, pairing } = useDaemonConnectionStore.getState();
  if (status === 'error') return error;
  if (status === 'pairing') return pairing?.message ?? null;
  return null;
}
