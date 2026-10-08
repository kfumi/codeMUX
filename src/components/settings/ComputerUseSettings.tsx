import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  COMPUTER_USE_MAX_STEPS,
  COMPUTER_USE_MIN_STEPS,
  formatAllowlistInput,
  normalizeComputerUse,
  parseAllowlistInput,
} from '../../lib/computerUseSettings';
import { daemonFacade } from '../../lib/facades/daemon-facade';
import { useSettingsStore } from '../../stores/settingsStore';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { TooltipHint } from '../ui/tooltip';
import { SettingsRow } from './SettingsRow';

interface DiagnosticCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string | null;
}

interface DriverStatusView {
  configured: boolean;
  running: boolean;
  command?: string | null;
  serverName?: string | null;
  version?: string | null;
  tools: string[];
  lastError?: string | null;
}

/**
 * 生效的升级通道(工单 09):`command` = 用户在下面填的更新命令;
 * `self` = 驱动自带升级(cua-driver update --apply)。null = 没驱动也没命令。
 */
interface UpdateChannelView {
  kind: 'command' | 'self';
  command: string;
}

interface DriverSnapshot {
  status: DriverStatusView;
  updateChannel: UpdateChannelView | null;
  builtinDenyList: Array<{ match: string; scope: string }>;
  resolution: DriverResolutionView | null;
}

/** daemon 的解析结论(工单 08):配置优先,其次自动探测,都没有 = missing。 */
interface DriverResolutionView {
  mode: 'custom' | 'auto' | 'missing';
  command?: string | null;
  detectedPath?: string | null;
}

const EMPTY_SNAPSHOT: DriverSnapshot = {
  status: { configured: false, running: false, tools: [] },
  updateChannel: null,
  builtinDenyList: [],
  resolution: null,
};

/**
 * 电脑控制设置(工单 06):总开关、允许范围、步数上限、驱动一站管完。
 *
 * 驱动状态与诊断是**按需拉取**的运行时事实(不是配置),因此不进 settingsStore;
 * 配置项走 setComputerUse(乐观更新 + 失败回滚,与浏览器控制同套)。
 */
export function ComputerUseSettings() {
  const config = useSettingsStore((state) => state.config);
  const setComputerUse = useSettingsStore((state) => state.setComputerUse);
  const [snapshot, setSnapshot] = useState<DriverSnapshot>(EMPTY_SNAPSHOT);
  const [checks, setChecks] = useState<DiagnosticCheck[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [allowlistDraft, setAllowlistDraft] = useState<string | null>(null);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);

  const computerUse = normalizeComputerUse(config?.computer_use);

  const resolution = snapshot.resolution;
  const driverMissing = resolution?.mode === 'missing';
  // 升级通道(工单 09):更新命令留空时用驱动自带升级,按钮不再要求用户先填命令。
  const updateChannel = snapshot.updateChannel ?? null;

  const refresh = useCallback(async () => {
    try {
      const result = (await daemonFacade.computerUse.driverStatus()) as DriverSnapshot;
      setSnapshot({
        status: result.status ?? EMPTY_SNAPSHOT.status,
        updateChannel: result.updateChannel ?? null,
        builtinDenyList: Array.isArray(result.builtinDenyList) ? result.builtinDenyList : [],
        resolution:
          (result as unknown as { driverResolution?: DriverResolutionView | null })
            .driverResolution ?? null,
      });
    } catch {
      // daemon 未就绪/浏览器形态:保持空快照,界面按「未知」展示而不是报错。
      setSnapshot(EMPTY_SNAPSHOT);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!config) return null;

  const update = (patch: Partial<typeof computerUse>) => {
    void setComputerUse({ ...computerUse, ...patch }).catch((error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  };

  const runAction = async (key: string, action: () => Promise<unknown>, successText: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(successText);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const runDiagnostics = async () => {
    setBusy('diagnose');
    try {
      const result = (await daemonFacade.computerUse.diagnostics()) as {
        checks?: DiagnosticCheck[];
      };
      setChecks(Array.isArray(result.checks) ? result.checks : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  /** 一键更新:确认对话框里点过「执行更新」之后才真的调用(接口层也强制 confirm)。 */
  const runUpdate = async () => {
    setUpdateConfirmOpen(false);
    await runAction('update', () => daemonFacade.computerUse.updateDriver(), '更新命令已执行');
  };

  /** 一键安装:确认对话框里点过「下载并安装」之后才真的调用(接口层强制 confirm)。 */
  const runInstall = async () => {
    setInstallConfirmOpen(false);
    await runAction('install', () => daemonFacade.computerUse.installDriver(), '安装脚本已执行');
  };

  const allowlistText = allowlistDraft ?? formatAllowlistInput(computerUse.allowlist);
  const allowlistDirty = allowlistDraft !== null;
  // daemon 不可达时退回内置清单:拒绝列表不可删除这件事必须在界面上看得见,
  // 不能因为拿不到状态就整块消失。
  const denyScopes = () =>
    snapshot.builtinDenyList.length > 0
      ? Array.from(new Set(snapshot.builtinDenyList.map((entry) => entry.scope)))
      : Array.from(new Set(DEFAULT_DENY_SCOPES));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsRow
          surface
          inlineControl
          label="开启电脑控制"
          description="允许会话读取桌面窗口清单与截图（只读观测）。默认关闭；与「浏览器控制」是两个开关，互不代管。"
          control={
            <Switch
              aria-label="开启电脑控制"
              checked={computerUse.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          }
        />
        <SettingsRow
          surface
          inlineControl
          label="系统级执行"
          description="开启后驱动才能启动，智能体可经驱动操作原生应用界面。每一步输入动作仍要你放行。"
          control={
            <Switch
              aria-label="系统级执行"
              checked={computerUse.system_execution_enabled}
              onCheckedChange={(checked) => update({ system_execution_enabled: checked })}
            />
          }
        />
        <SettingsRow
          surface
          label="步数上限"
          description="一轮对话里输入动作的上限（1-200，只读观看不计数）；到顶智能体会停下等你接手。"
          control={
            <Input
              type="number"
              aria-label="步数上限"
              min={COMPUTER_USE_MIN_STEPS}
              max={COMPUTER_USE_MAX_STEPS}
              value={computerUse.max_steps}
              onChange={(event) => update({ max_steps: Number(event.target.value) })}
              className="h-8 w-24 text-ui-body"
            />
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <label className="text-ui-compact font-medium text-muted-foreground">驱动</label>
        <div className="space-y-3 rounded-xl settings-tile p-4">
          <div className="flex flex-wrap items-center gap-2 text-ui-body">
            <span
              className={
                snapshot.status.running
                  ? 'flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-ui-caption text-success'
                  : 'flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-ui-caption text-muted-foreground'
              }
            >
              {snapshot.status.running ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
              {snapshot.status.running ? '运行中' : '未运行'}
            </span>
            <span className="text-muted-foreground">
              {resolution?.command
                ? `${resolution.command}${snapshot.status.version ? ` · ${snapshot.status.version}` : ''}`
                : driverMissing
                  ? '未检测到 cua-driver(官方安装位置与 PATH)'
                  : '未配置驱动命令'}
            </span>
            {resolution?.mode === 'auto' ? (
              <span className="rounded-md border border-border px-2 py-0.5 text-ui-caption text-muted-foreground">
                自动检测
              </span>
            ) : null}
            {snapshot.status.tools.length > 0 ? (
              <span className="text-ui-caption text-muted-foreground">
                {snapshot.status.tools.length} 个工具
              </span>
            ) : null}
          </div>
          {snapshot.status.lastError ? (
            <p className="text-ui-caption text-warning">{snapshot.status.lastError}</p>
          ) : null}

          {driverMissing ? (
            <p className="text-ui-caption text-warning">
              未检测到 cua-driver。可一键安装官方驱动,或手动填写驱动命令。
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void runAction('refresh', refresh, '已重新检测')}
            >
              {busy === 'refresh' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              重新检测
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null || !computerUse.system_execution_enabled}
              onClick={() =>
                void runAction('start', () => daemonFacade.computerUse.startDriver(), '驱动已启动')
              }
            >
              启动驱动
            </Button>
            {driverMissing ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => setInstallConfirmOpen(true)}
              >
                一键安装
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void runDiagnostics()}
            >
              {busy === 'diagnose' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              一键诊断
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void runAction('estop', () => daemonFacade.computerUse.estopDriver(), '已急停：驱动子进程被杀')
              }
            >
              急停
            </Button>
            {updateChannel ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => setUpdateConfirmOpen(true)}
              >
                更新驱动
              </Button>
            ) : (
              // 没有可用升级通道时不留一个必然失败的控件:按钮禁用 + 说明为什么。
              <TooltipHint content="没有可用升级通道:先「一键安装」装官方驱动,或在下方「更新命令」里填升级方式">
                <Button type="button" variant="outline" size="sm" disabled>
                  更新驱动
                </Button>
              </TooltipHint>
            )}
          </div>

          {checks ? (
            <ul className="space-y-1.5 border-t border-border pt-3">
              {checks.map((check) => (
                <li key={check.id} className="text-ui-caption">
                  <span className={check.ok ? 'text-success' : 'text-warning'}>
                    {check.ok ? '通过' : '待修'}
                  </span>
                  <span className="ml-2 text-foreground">{check.label}</span>
                  <span className="ml-2 text-muted-foreground">{check.detail}</span>
                  {!check.ok && check.fix ? (
                    <span className="ml-2 text-muted-foreground">→ {check.fix}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <ConfirmDialog
        open={updateConfirmOpen}
        onOpenChange={setUpdateConfirmOpen}
        title="更新驱动？"
        description={
          updateChannel?.kind === 'self'
            ? `将执行驱动自带升级：${updateChannel.command} update --apply（查最新版并走官方安装器原地升级）。升级前会先停下正在运行的驱动。`
            : `将执行更新命令：${updateChannel?.command ?? ''}。升级前会先停下正在运行的驱动。`
        }
        confirmLabel="执行更新"
        cancelLabel="取消"
        onConfirm={() => void runUpdate()}
        loading={busy === 'update'}
      />

      <ConfirmDialog
        open={installConfirmOpen}
        onOpenChange={setInstallConfirmOpen}
        title="安装 cua-driver？"
        description={`将从 ${INSTALL_SCRIPT_URL} 下载并运行官方安装脚本,装完点「启动驱动」。`}
        confirmLabel="下载并安装"
        cancelLabel="取消"
        onConfirm={() => void runInstall()}
        loading={busy === 'install'}
      />

      <section className="flex flex-col gap-3">
        <label className="text-ui-compact font-medium text-muted-foreground">驱动配置</label>
        <div className="space-y-3 rounded-xl settings-tile p-4">
          <div className="flex flex-col gap-1">
            <label className="text-ui-body text-foreground" htmlFor="computer-use-driver-command">
              驱动命令
            </label>
            <input
              id="computer-use-driver-command"
              value={computerUse.driver_command ?? ''}
              placeholder={
                resolution?.mode === 'auto' && resolution.command
                  ? `留空 = 自动:${resolution.command}`
                  : driverMissing
                    ? '未检测到,可一键安装或手动填路径'
                    : '如 cua-driver 或 C:\\path\\to\\driver.exe'
              }
              onChange={(event) =>
                update({ driver_command: event.target.value.trim() ? event.target.value : null })
              }
              className="h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-code text-foreground"
            />
            <p className="text-ui-caption text-muted-foreground">
              留空 = 自动检测 cua-driver(官方安装位置与 PATH);驱动需支持 stdio MCP。
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-ui-body text-foreground" htmlFor="computer-use-driver-args">
              启动参数
            </label>
            <Input
              id="computer-use-driver-args"
              value={computerUse.driver_args.join(' ')}
              placeholder="留空 = mcp(cua-driver 官方 MCP 子命令);自定义驱动才需要填,如 --stdio"
              onChange={(event) => update({ driver_args: parseArgsInput(event.target.value) })}
              className="h-8 font-mono text-code"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-ui-body text-foreground" htmlFor="computer-use-driver-update">
              更新命令
            </label>
            <Input
              id="computer-use-driver-update"
              value={computerUse.driver_update_command ?? ''}
              placeholder="留空 = 驱动自带升级（cua-driver update --apply）"
              onChange={(event) =>
                update({
                  driver_update_command: event.target.value.trim() ? event.target.value : null,
                })
              }
              className="h-8 font-mono text-code"
            />
            <p className="text-ui-caption text-muted-foreground">
              留空时用驱动自带升级（cua-driver update --apply，查最新版并走官方安装器原地升级）；npm、Homebrew 等包管理器装的才需要在这里覆盖。每次升级都会先问过你。
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <label className="text-ui-compact font-medium text-muted-foreground">可操作范围</label>
        <div className="space-y-3 rounded-xl settings-tile p-4">
          <div className="flex flex-col gap-1">
            <label className="text-ui-body text-foreground" htmlFor="computer-use-allowlist">
              允许列表（每行一个应用名）
            </label>
            <textarea
              id="computer-use-allowlist"
              value={allowlistText}
              rows={4}
              placeholder="留空 = 除内置拒绝外全部可操作"
              onChange={(event) => setAllowlistDraft(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-code text-foreground"
            />
            <p className="text-ui-caption text-muted-foreground">
              留空表示除内置拒绝列表外都可以操作；填了就只允许列出的应用。
            </p>
            {allowlistDirty ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    update({ allowlist: parseAllowlistInput(allowlistText) });
                    setAllowlistDraft(null);
                  }}
                >
                  保存允许列表
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAllowlistDraft(null)}>
                  取消
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <span className="text-ui-body text-foreground">内置拒绝列表（不可删除）</span>
            <p className="text-ui-caption text-muted-foreground">
              这些永远不可操作：密码管理器、终端、锁屏、Windows 安全中心，以及 CodeMUX 自己、安装器和更新器。
              允许列表写了也没用。
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {denyScopes().map((scope) => (
                <span
                  key={scope}
                  className="rounded-md border border-border px-2 py-0.5 text-ui-caption text-muted-foreground"
                >
                  {scope}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/** daemon 不可达时的兜底展示(与 Rust 侧 BUILTIN_DENY 的 scope 对齐)。 */
const DEFAULT_DENY_SCOPES = [
  '密码管理器',
  '终端',
  '锁屏',
  'Windows 安全中心',
  'CodeMUX 自身与安装更新器',
];

/** 与 daemon 侧 probe::INSTALL_SCRIPT_URL 保持一致(一键安装的唯一下载源)。 */
const INSTALL_SCRIPT_URL = 'https://cua.ai/driver/install.ps1';

/** 参数输入:空格分隔(驱动参数不含空格的常见情形;含空格请写成多条)。 */
function parseArgsInput(text: string): string[] {
  return text
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 20);
}
