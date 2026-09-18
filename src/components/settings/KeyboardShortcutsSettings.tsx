import { useCallback, useEffect, useMemo, useState } from 'react';
import { Power, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import {
  SHORTCUT_COMMANDS,
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_GROUP_ORDER,
  countKeybindingOverrides,
  findKeybindingConflict,
  isAllowedKeybinding,
  isKeybindingCustomized,
  isReservedKeybinding,
  keybindingFromEvent,
  resetKeybindingOverride,
  resolveKeybinding,
  shouldIgnoreKeydown,
  withKeybindingOverride,
  type KeybindingOverrides,
  type ShortcutCommand,
  type ShortcutCommandId,
} from '../../lib/shortcuts/keyboardShortcuts';
import { getShortcutPlatform } from '../../lib/shortcuts/shortcutPlatform';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { ShortcutKeys } from '../shortcuts/ShortcutKeys';
import { Button } from '../ui/button';
import { TooltipHint } from '../ui/tooltip';

/** 被拒时的文案集中在此，避免与测试期望漂移。 */
const REJECT_NO_MODIFIER = '至少需要一个修饰键，或使用 F1–F12';
const REJECT_RESERVED = '这个键位被系统或编辑器占用，换一个';
const SAVE_FAILED_TOAST = '快捷键保存失败';

/** 行尾图标按钮：视觉与 MainLayout 的图标按钮一致。 */
const ICON_BUTTON_CLASS =
  'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground';

/** 行内正在保存的目标；`all` 代表「全部恢复默认」。 */
type SavingTarget = ShortcutCommandId | 'all';

/** 原生事件没有 `nativeEvent`，React 合成事件才有；两种都收一次录制。 */
type KeyboardEventSource = KeyboardEvent & { nativeEvent?: KeyboardEvent };

/**
 * 设置页的快捷键分区：内置命令的键位可改、可禁用、可恢复默认。
 *
 * 判定（可绑定 / 保留 / 冲突）全部来自 `src/lib/shortcuts/keyboardShortcuts.ts`，
 * 这里只负责交互与呈现；被拒的录制不写配置。决策见
 * [ADR 0013](../../../docs/adr/0013-user-configurable-keyboard-shortcuts.md)。
 */
export function KeyboardShortcutsSettings() {
  const config = useSettingsStore((state) => state.config);
  const overrides = useSettingsStore((state) => state.config?.keybindings);
  const setKeybindings = useSettingsStore((state) => state.setKeybindings);
  // 平台只解析一次：它只用来渲染键帽与解析 `Mod`。
  const platform = useMemo(() => getShortcutPlatform(), []);
  const [recordingCommandId, setRecordingCommandId] = useState<ShortcutCommandId | null>(null);
  const [savingTarget, setSavingTarget] = useState<SavingTarget | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const saveKeybindings = useCallback(
    async (target: SavingTarget, next: KeybindingOverrides) => {
      setSavingTarget(target);
      setErrorMessage(null);
      try {
        await setKeybindings(next);
      } catch (error) {
        // store 已经回滚了乐观更新；这里只把失败告诉用户（与 GitSettings 的写法一致）。
        setErrorMessage(String(error));
        toast.error(SAVE_FAILED_TOAST);
      } finally {
        setSavingTarget(null);
      }
    },
    [setKeybindings],
  );

  // 录制：整个窗口只留一个捕获期监听，录完或拒绝后立刻摘掉。
  useEffect(() => {
    if (!recordingCommandId) return;
    const command = SHORTCUT_COMMANDS.find((candidate) => candidate.id === recordingCommandId);
    if (!command) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // 这次按键属于录制，不能同时喂给分发器或输入框。
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') {
        // Escape 故意不可绑定（见 ADR 0013），按它就是放弃录制。
        setRecordingCommandId(null);
        return;
      }
      // 只按下修饰键、或输入法组字中的按键不算一次录制，继续等下一个键。
      if (shouldIgnoreKeydown(event)) return;

      const source = (event as KeyboardEventSource).nativeEvent ?? event;
      const binding = keybindingFromEvent(source, platform);
      if (!binding || !isAllowedKeybinding(binding)) {
        toast.error(REJECT_NO_MODIFIER);
        setRecordingCommandId(null);
        return;
      }
      if (isReservedKeybinding(binding, platform)) {
        toast.error(REJECT_RESERVED);
        setRecordingCommandId(null);
        return;
      }
      const conflict = findKeybindingConflict(command, binding, overrides, platform);
      if (conflict) {
        toast.error(`与「${conflict.label}」冲突`);
        setRecordingCommandId(null);
        return;
      }

      setRecordingCommandId(null);
      void saveKeybindings(command.id, withKeybindingOverride(overrides, command, binding, platform));
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingCommandId, overrides, platform, saveKeybindings]);

  // 点别处就放弃录制（行内点击不算，否则按钮自己一按就退出）。
  useEffect(() => {
    if (!recordingCommandId) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-recording="true"]')) return;
      setRecordingCommandId(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [recordingCommandId]);

  if (!config) return null;

  const overrideCount = countKeybindingOverrides(overrides);
  const busy = savingTarget !== null;

  const renderCommandRow = (command: ShortcutCommand) => {
    const binding = resolveKeybinding(command, overrides, platform);
    const customized = isKeybindingCustomized(command, overrides);
    const disabled = binding === null;
    const isRecording = recordingCommandId === command.id;
    const isSaving = savingTarget === command.id;

    return (
      <div
        key={command.id}
        data-testid={`shortcut-row-${command.id}`}
        className="flex items-center justify-between gap-4 rounded-lg settings-tile py-2 pl-4 pr-2"
      >
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {command.label}
        </div>
        <div
          data-recording={isRecording ? 'true' : undefined}
          className="flex shrink-0 items-center gap-1.5"
        >
          {/* 键位本身就是录制入口：点它，然后按下组合键。 */}
          <TooltipHint content={isRecording ? '按 Esc 取消录制' : '点这里后按下要绑定的组合键'}>
            <button
              type="button"
              data-testid={`shortcut-record-${command.id}`}
              aria-pressed={isRecording}
              aria-label={`修改「${command.label}」的键位`}
              disabled={isSaving}
              onClick={() => {
                setErrorMessage(null);
                setRecordingCommandId(isRecording ? null : command.id);
              }}
              className={cn(
                'inline-flex h-7 w-28 items-center justify-end rounded-md border px-2 transition-colors disabled:cursor-default sm:w-40',
                isRecording
                  ? 'border-primary/50 bg-primary/[0.06] ring-2 ring-primary/25'
                  : 'border-border/70 bg-background hover:border-border hover:bg-foreground/5',
                isSaving && 'opacity-50',
              )}
            >
              {isRecording ? (
                <span className="text-ui-caption font-medium text-primary">按下组合键…</span>
              ) : (
                <span data-testid={`shortcut-binding-${command.id}`}>
                  <ShortcutKeys
                    binding={binding}
                    platform={platform}
                    variant="plain"
                    emptyLabel={disabled ? '已禁用' : '未绑定'}
                  />
                </span>
              )}
            </button>
          </TooltipHint>
          <TooltipHint content="禁用：这条命令不再占用任何键位">
            <button
              type="button"
              data-testid={`shortcut-disable-${command.id}`}
              aria-label={`禁用「${command.label}」`}
              disabled={disabled || busy}
              onClick={() => {
                setRecordingCommandId(null);
                void saveKeybindings(
                  command.id,
                  withKeybindingOverride(overrides, command, null, platform),
                );
              }}
              className={ICON_BUTTON_CLASS}
            >
              <Power className="h-3.5 w-3.5" />
            </button>
          </TooltipHint>
          <TooltipHint content="恢复这条命令的默认键位">
            <button
              type="button"
              data-testid={`shortcut-reset-${command.id}`}
              aria-label={`恢复「${command.label}」的默认键位`}
              disabled={!customized || busy}
              onClick={() => {
                setRecordingCommandId(null);
                void saveKeybindings(command.id, resetKeybindingOverride(overrides, command.id));
              }}
              className={ICON_BUTTON_CLASS}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </TooltipHint>
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-ui-title font-medium text-foreground">快捷键</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="shortcut-reset-all"
          disabled={overrideCount === 0 || busy}
          onClick={() => {
            setRecordingCommandId(null);
            void saveKeybindings('all', {});
          }}
          className="gap-1.5 text-muted-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          恢复默认
        </Button>
      </div>

      {SHORTCUT_GROUP_ORDER.map((group) => {
        const commands = SHORTCUT_COMMANDS.filter((command) => command.group === group);
        if (commands.length === 0) return null;
        return (
          <div key={group} className="space-y-1.5 pt-1">
            <div className="px-1 text-ui-caption font-medium text-muted-foreground">
              {SHORTCUT_GROUP_LABELS[group]}
            </div>
            <div className="space-y-1.5">{commands.map(renderCommandRow)}</div>
          </div>
        );
      })}

      <div className="space-y-1 px-1 pt-1">
        <p className="text-ui-caption leading-relaxed text-muted-foreground">
          点键位即可录新组合，Esc 取消；浏览器宿主里部分组合属于浏览器自身，可能不生效。
        </p>
        {errorMessage && (
          <p className="text-ui-caption leading-relaxed text-destructive">保存失败：{errorMessage}</p>
        )}
      </div>
    </section>
  );
}
