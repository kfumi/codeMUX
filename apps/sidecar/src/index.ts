import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnsureSessionCommand, SidecarCommand } from './types.js';
import { resolveClaudeToolResponse, SessionRuntime } from './claudeRuntime.js';
import { CodexAppServerRuntime } from './codexAppServerRuntime.js';
import { createOpenCodeSidecarRuntime } from './opencodeSidecarRuntime.js';
import { createPiSidecarRuntime } from './piSidecarRuntime.js';
import type { SidecarRuntime } from './runtimePort.js';
import { isNativeResumeFailure } from './runtimeErrors.js';
import { getRuntimeFlavor } from './runtimeEvents.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';
import { deleteOpenCodeSessionWithOfficialSdk } from './opencodeSdk.js';
import { enrichAttachments } from './attachmentEnrichment/index.js';
import { isSteerUnavailableError, SteerUnavailableError } from './steer.js';
import {
  buildClaudeUserMessageContent,
  getDisplayPayloadAttachments,
  normalizeAgentInputPayload,
  type AgentInputPayload,
} from './agentInputPayload.js';
import { emit } from './streamEventBatcher.js';
import { proxyManager } from './proxyManager.js';
import { setLogCtx, writeLog } from './writeLog.js';

// Suppress unhandled abort rejections from child process termination during interrupt.
// These are expected when the user cancels a running Codex turn.
process.on('unhandledRejection', (reason) => {
  const msg = String(reason).toLowerCase();
  if (msg.includes('abort') || msg.includes('the operation was aborted')) {
    process.stderr.write(`[sidecar] Suppressed unhandled abort rejection: ${reason}\n`);
    return;
  }
  // Re-throw non-abort errors so they are not silently swallowed.
  process.stderr.write(`[sidecar] Unhandled rejection: ${reason}\n`);
});

const SIDECAR_DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

function isSidecarEntrypoint(scriptPath: string | undefined): boolean {
  if (!scriptPath) return false;

  const entrypoint = path.join(SIDECAR_DIST_DIR, 'index.js');
  try {
    return fs.realpathSync.native(scriptPath) === fs.realpathSync.native(entrypoint);
  } catch {
    return path.resolve(scriptPath) === entrypoint;
  }
}


export function buildUserMessageEvent(
  sessionId: string,
  prompt: string,
  inputPayload?: AgentInputPayload,
  displayContent?: string,
): Record<string, unknown> {
  const payload = normalizeAgentInputPayload(prompt, inputPayload);
  const displayAttachments = getDisplayPayloadAttachments(payload);
  const displayPayload: AgentInputPayload = {
    text: displayContent ?? payload.text,
    attachments: displayAttachments,
    images: displayAttachments.map(({ name, mediaType, dataUrl, size }) => ({ name, mediaType, dataUrl, size })),
  };
  const imageBlocks = buildClaudeUserMessageContent(displayPayload, true)
    .filter((block): block is { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } => block.type === 'image')
    .map((block, index) => ({
      ...block,
      ...(displayAttachments[index]?.name ? { name: displayAttachments[index].name } : {}),
    }));

  return {
    type: 'user_message',
    session_id: sessionId,
    content: imageBlocks.length > 0
      ? [{ type: 'text', text: displayContent ?? payload.text }, ...imageBlocks]
      : displayContent ?? payload.text,
  };
}

const runtime = new SessionRuntime();
const codexRuntime = new CodexAppServerRuntime();

type SidecarCommandDispatcherOptions = {
  claudeRuntime: SidecarRuntime;
  codexRuntime: SidecarRuntime;
  createOpenCodeRuntime: (cmd: EnsureSessionCommand) => SidecarRuntime;
  createPiRuntime: (cmd: EnsureSessionCommand) => SidecarRuntime;
  emit: (event: unknown) => void;
  startProxy?: (cmd: Extract<SidecarCommand, { type: 'start_proxy' }>) => Promise<unknown>;
  stopProxy: () => Promise<void>;
  getProxyStatus?: () => Record<string, unknown>;
  exit: (code: number) => void;
};

export function createSidecarCommandDispatcher(options: SidecarCommandDispatcherOptions) {
  let activeAgentKind: string | undefined;
  let activeSessionId: string | undefined;
  let activeResumeOnly = false;
  let activeAgentSessionId: string | undefined;
  let activeManagedRuntime: { flavor: 'opencode' | 'pi'; runtime: SidecarRuntime } | undefined;
  let ensureTail: Promise<void> = Promise.resolve();
  const pendingPermissionResponses = new Map<SidecarRuntime, Map<string, Promise<void>>>();

  const emitError = (error: unknown): void => {
    options.emit({ type: 'sidecar_error', error: String(error) });
  };

  /**
   * Emit a turn-terminal `error` event. `sidecar_error` is only for diagnostics
   * and is neither persisted nor treated as terminal by the daemon, so a failed
   * turn start that only emits `sidecar_error` leaves the session stuck
   * "running" (and later sends enqueued forever). Mirror the runtime's own
   * failure events so the turn actually finishes.
   */
  const emitTurnFailure = (sessionId: string | undefined, error: unknown): void => {
    emitError(error);
    if (sessionId) {
      options.emit({ type: 'error', session_id: sessionId, subtype: 'failed', error: String(error) });
    }
  };

  const isAbortError = (error: unknown): boolean => {
    const message = String(error).toLowerCase();
    return message.includes('abort') || message.includes('the operation was aborted');
  };

  const shutdownManagedRuntime = async (): Promise<void> => {
    const current = activeManagedRuntime;
    if (!current) return;
    await current.runtime.shutdown();
    if (activeManagedRuntime === current) {
      activeManagedRuntime = undefined;
    }
  };

  const ensureSession = async (cmd: EnsureSessionCommand): Promise<void> => {
    const flavor = getRuntimeFlavor(cmd.agentKind);
    // 附加目录不可用是会话级事实：发一条可持久化的系统事件让界面提示。
    // event_id 稳定，重建 runtime 时重复 ensure 不会刷屏。
    if (cmd.unavailableAdditionalDirectories?.length) {
      const unavailable = [...cmd.unavailableAdditionalDirectories].sort();
      options.emit({
        type: 'system_event',
        subtype: 'additional_directories_unavailable',
        session_id: cmd.sessionId,
        event_id: `additional-directories-unavailable:${cmd.sessionId ?? ''}:${unavailable.join('|')}`,
        content: `以下源文件夹当前不可用，已跳过：${unavailable.join('、')}`,
      });
    }
    activeAgentKind = cmd.agentKind;
    activeSessionId = cmd.sessionId;
    activeResumeOnly = cmd.resumeOnly === true;
    activeAgentSessionId = cmd.agentSessionId;
    if (flavor !== 'opencode' && flavor !== 'pi') {
      await shutdownManagedRuntime();
      const selectedRuntime = flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
      await selectedRuntime.ensure(cmd);
      return;
    }

    const current = activeManagedRuntime;
    if (current?.flavor === flavor && current.runtime.canReuse?.(cmd)) {
      process.stderr.write(
        `[${flavor}-task] ensure_session REUSE sessionId=${cmd.sessionId ?? 'null'}\n`,
      );
      await current.runtime.updatePermissions({
        type: 'update_permissions',
        sessionId: cmd.sessionId,
        agentKind: cmd.agentKind,
        permissionConfig: cmd.permissionConfig,
        planMode: cmd.planMode,
      });
      current.runtime.emitSessionMapping?.(cmd);
      return;
    }

    await shutdownManagedRuntime();
    const nextRuntime = flavor === 'pi' ? options.createPiRuntime(cmd) : options.createOpenCodeRuntime(cmd);
    try {
      await nextRuntime.ensure(cmd);
    } catch (error) {
      try {
        await nextRuntime.shutdown();
      } catch (cleanupError) {
        emitError(`${String(error)}; ${flavor} cleanup failed: ${String(cleanupError)}`);
      }
      throw error;
    }
    activeManagedRuntime = { flavor, runtime: nextRuntime };
  };

  const dispatchEnsure = (cmd: EnsureSessionCommand): Promise<void> => {
    const operation = ensureTail.then(() => ensureSession(cmd), () => ensureSession(cmd));
    ensureTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const selectedRuntime = (): SidecarRuntime | undefined => {
    const flavor = getRuntimeFlavor(activeAgentKind);
    if (flavor === 'opencode' || flavor === 'pi') return activeManagedRuntime?.flavor === flavor ? activeManagedRuntime.runtime : undefined;
    return flavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
  };

  const dispatch = async (cmd: SidecarCommand): Promise<void> => {
    const cmdSessionId = (cmd as { sessionId?: string }).sessionId;
    if (cmdSessionId) {
      setLogCtx({ sessionId: cmdSessionId });
    }
    switch (cmd.type) {
      case 'ensure_session':
        try {
          await dispatchEnsure(cmd);
        } catch (error) {
          if (cmd.resumeOnly && cmd.agentSessionId && isNativeResumeFailure(error)) {
            options.emit({
              type: 'session_resume_failed',
              session_id: cmd.sessionId,
              agent_kind: cmd.agentKind,
              agent_session_id: cmd.agentSessionId,
              error: String(error),
            });
          } else {
            emitError(error);
          }
        }
        return;
      case 'update_permissions': {
        activeAgentKind = cmd.agentKind ?? activeAgentKind;
        const flavor = getRuntimeFlavor(activeAgentKind);
        if (flavor === 'pi') {
          // pi 权限档位经 canReuse 比对在下一轮 ensure 重建生效，原地更新为 no-op。
          return;
        }
        try {
          if (flavor === 'opencode') {
            const current = selectedRuntime();
            if (!current) throw new Error('OpenCode runtime is not initialized');
            await current.updatePermissions(cmd);
          } else {
            await (flavor === 'codex' ? options.codexRuntime : options.claudeRuntime).updatePermissions(cmd);
          }
        } catch (error) {
          emitError(error);
        }
        return;
      }
      case 'enrich_attachments': {
        try {
          process.stderr.write(
            `[sidecar] Attachment enrichment START model=${cmd.model} baseUrl=${cmd.baseUrl} attachments=${cmd.attachments.length}\n`,
          );
          const blocks = await enrichAttachments(cmd.attachments, {
            protocol: cmd.protocol,
            apiKey: cmd.apiKey,
            baseUrl: cmd.baseUrl,
            model: cmd.model,
          });
          for (const block of blocks) {
            if (block.ok) {
              process.stderr.write(
                `[sidecar] Attachment enrichment OK name=${block.attachment_name} chars=${block.markdown.length}\n`,
              );
            } else {
              process.stderr.write(
                `[sidecar] Attachment enrichment FAILED name=${block.attachment_name} error=${block.error ?? 'unknown'}\n`,
              );
            }
          }
          options.emit({
            type: 'enrichment_result',
            request_id: cmd.requestId,
            ok: true,
            blocks,
          });
        } catch (error) {
          options.emit({
            type: 'enrichment_result',
            request_id: cmd.requestId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'send_input': {
        await ensureTail;
        const sessionId = cmd.sessionId ?? activeSessionId;
        const current = selectedRuntime();
        if (!current) {
          emitTurnFailure(sessionId, `${getRuntimeFlavor(activeAgentKind)} runtime is not initialized`);
          return;
        }
        if (cmd.delivery === 'steer') {
          try {
            if (!current.steerActiveTurn) {
              throw new SteerUnavailableError(`${getRuntimeFlavor(activeAgentKind)} runtime does not support steer`);
            }
            await current.steerActiveTurn(cmd.prompt, cmd.inputPayload);
            if (sessionId) {
              options.emit(buildUserMessageEvent(sessionId, cmd.prompt, cmd.inputPayload, cmd.displayContent));
            }
            if (cmd.requestId) {
              options.emit({ type: 'steer_result', request_id: cmd.requestId, ok: true });
            }
          } catch (error) {
            if (cmd.requestId) {
              options.emit({
                type: 'steer_result',
                request_id: cmd.requestId,
                ok: false,
                unavailable: isSteerUnavailableError(error),
                error: String(error),
              });
            } else if (!isSteerUnavailableError(error)) {
              emitError(error);
            }
          }
          return;
        }
        if (sessionId) {
          options.emit(buildUserMessageEvent(sessionId, cmd.prompt, cmd.inputPayload, cmd.displayContent));
        }
        void current.sendInput(cmd.prompt, cmd.inputPayload).catch((error) => {
          if (activeResumeOnly && activeAgentSessionId && isNativeResumeFailure(error)) {
            options.emit({
              type: 'session_resume_failed',
              session_id: activeSessionId,
              agent_kind: activeAgentKind,
              agent_session_id: activeAgentSessionId,
              error: String(error),
            });
          } else if (!isAbortError(error)) {
            emitTurnFailure(sessionId, error);
          }
        });
        return;
      }
      case 'fork_session': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          const flavor = getRuntimeFlavor(activeAgentKind);
          if (
            (flavor !== 'claude' && flavor !== 'codex' && flavor !== 'opencode' && flavor !== 'pi')
            || !current?.forkSession
          ) {
            throw new Error('This provider runtime does not support session fork');
          }
          const agentSessionId = await current.forkSession(
            cmd.sourceAgentSessionId,
            cmd.sourceProviderTurnId,
            cmd.sourceProviderTurnOrdinal,
            cmd.sourceProviderMessageId,
          );
          options.emit({
            type: 'session_fork_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            agent_kind: activeAgentKind,
            agent_session_id: agentSessionId,
            ok: true,
          });
        } catch (error) {
          options.emit({
            type: 'session_fork_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            agent_kind: activeAgentKind,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'rewind_files': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          const flavor = getRuntimeFlavor(activeAgentKind);
          if (flavor !== 'claude' || !current?.rewindFiles) {
            throw new Error('This provider runtime does not support file rewind');
          }
          const filesChanged = await current.rewindFiles(cmd.providerMessageId);
          options.emit({
            type: 'session_rewind_files_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
            files_changed: filesChanged,
          });
        } catch (error) {
          options.emit({
            type: 'session_rewind_files_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'rewind_conversation': {
        await ensureTail;
        try {
          const current = selectedRuntime();
          if (!current?.rewindConversation) {
            throw new Error(
              `${getRuntimeFlavor(activeAgentKind)} runtime does not support conversation rewind`,
            );
          }
          const agentSessionId = await current.rewindConversation({
            entryId: cmd.entryId,
            providerMessageId: cmd.providerMessageId,
            providerMessageTurnOrdinal: cmd.providerMessageTurnOrdinal,
          });
          writeLog(
            `[${getRuntimeFlavor(activeAgentKind)}-task]`,
            `rewind_conversation OK agent_session_id=${agentSessionId}`,
          );
          options.emit({
            type: 'session_rewind_conversation_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
            agent_session_id: agentSessionId,
          });
        } catch (error) {
          writeLog(
            `[${getRuntimeFlavor(activeAgentKind)}-task]`,
            `rewind_conversation FAILED error=${error instanceof Error ? error.message : String(error)}`,
          );
          options.emit({
            type: 'session_rewind_conversation_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'reset_session':
        try {
          const current = selectedRuntime();
          if (!current) throw new Error('OpenCode runtime is not initialized');
          await current.resetSession(cmd.sessionId);
        } catch (error) {
          emitError(error);
        }
        return;
      case 'delete_session': {
        try {
          const current = selectedRuntime();
          if (current?.deleteSession) {
            await current.deleteSession(cmd.agentSessionId);
          } else {
            if (!cmd.runtimeRef) {
              throw new Error('OpenCode Runtime is required before deleting a session');
            }
            await deleteOpenCodeSessionWithOfficialSdk({ cwd: cmd.cwd, sessionId: cmd.agentSessionId, runtimeRef: cmd.runtimeRef });
          }
          options.emit({
            type: 'session_delete_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: true,
          });
        } catch (error) {
          options.emit({
            type: 'session_delete_result',
            request_id: cmd.requestId,
            session_id: cmd.sessionId,
            ok: false,
            error: String(error),
          });
        }
        return;
      }
      case 'interrupt':
        try {
          const current = selectedRuntime();
          if (!current) throw new Error(`${getRuntimeFlavor(activeAgentKind)} runtime is not initialized`);
          await current.interrupt();
        } catch (error) {
          if (!isAbortError(error)) emitError(error);
        }
        return;
      case 'tool_response': {
        const flavor = getRuntimeFlavor(activeAgentKind);
        const openCodeRuntime = flavor === 'opencode'
          ? (activeManagedRuntime?.flavor === 'opencode' ? activeManagedRuntime.runtime : undefined)
          : undefined;
        const codexQuestionRuntime = flavor === 'codex' ? options.codexRuntime : undefined;
        const piRuntime = flavor === 'pi'
          ? (activeManagedRuntime?.flavor === 'pi' ? activeManagedRuntime.runtime : undefined)
          : undefined;
        if (openCodeRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          openCodeRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (codexQuestionRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          codexQuestionRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (piRuntime?.isPendingQuestion?.(cmd.toolUseId)) {
          const raw = Array.isArray(cmd.response) ? cmd.response : [];
          const answers = raw.map((a: unknown) => (Array.isArray(a) ? a : [String(a)]));
          piRuntime.respondToQuestion?.(cmd.toolUseId, answers).catch((err: unknown) => emitError(err));
        } else if (flavor === 'pi') {
          emitError('pi tool responses are only supported while a question is pending');
        } else if (openCodeRuntime) {
          options.emit({ type: 'sidecar_error', error: 'OpenCode tool responses are server-managed/not supported' });
        } else {
          resolveClaudeToolResponse(cmd.toolUseId, cmd.response);
        }
        return;
      }
      case 'respond_to_permission': {
        const flavor = getRuntimeFlavor(activeAgentKind);
        if (flavor === 'claude') {
          if (!resolveClaudeToolResponse(cmd.requestId, cmd.response)) {
            emitError(`Claude permission request ${cmd.requestId} is no longer pending`);
          }
          return;
        }
        const current = flavor === 'opencode'
          ? (activeManagedRuntime?.flavor === 'opencode' ? activeManagedRuntime.runtime : undefined)
          : flavor === 'codex'
            ? options.codexRuntime
            : flavor === 'pi'
              ? (activeManagedRuntime?.flavor === 'pi' ? activeManagedRuntime.runtime : undefined)
              : undefined;
        if (!current?.respondToPermission) {
          emitError(flavor === 'codex'
            ? 'Codex runtime is not initialized'
            : flavor === 'pi'
              ? 'pi runtime is not initialized'
              : 'OpenCode runtime is not initialized');
          return;
        }
        const runtimePendingResponses = pendingPermissionResponses.get(current) ?? new Map<string, Promise<void>>();
        pendingPermissionResponses.set(current, runtimePendingResponses);
        const responseKey = `${cmd.sessionId}:${cmd.requestId}`;
        if (runtimePendingResponses.has(responseKey)) return;
        const responseTask = Promise.resolve()
          .then(() => current.respondToPermission!(cmd.requestId, cmd.response as OpenCodePermissionResponse, cmd.sessionId))
          .catch((error) => {
            emitError(error);
          })
          .finally(() => {
            if (runtimePendingResponses.get(responseKey) === responseTask) {
              runtimePendingResponses.delete(responseKey);
            }
            if (runtimePendingResponses.size === 0 && pendingPermissionResponses.get(current) === runtimePendingResponses) {
              pendingPermissionResponses.delete(current);
            }
          });
        runtimePendingResponses.set(responseKey, responseTask);
        return;
      }
      case 'shutdown': {
        const cleanupErrors: unknown[] = [];
        const attemptCleanup = async (label: string, cleanup: () => Promise<void>): Promise<void> => {
          try {
            await cleanup();
          } catch (error) {
            cleanupErrors.push(new Error(`${label}: ${String(error)}`));
          }
        };
        await attemptCleanup('Failed to stop proxy', options.stopProxy);
        await attemptCleanup('Failed to shutdown managed runtime', shutdownManagedRuntime);
        const activeFlavor = getRuntimeFlavor(activeAgentKind);
        if (activeFlavor !== 'opencode' && activeFlavor !== 'pi') {
          const currentRuntime = activeFlavor === 'codex' ? options.codexRuntime : options.claudeRuntime;
          await attemptCleanup('Failed to shutdown active runtime', () => currentRuntime.shutdown());
        }
        if (cleanupErrors.length > 0) {
          const aggregateError = new AggregateError(cleanupErrors, 'Sidecar shutdown cleanup failed');
          options.emit({ type: 'sidecar_error', error: `${aggregateError.message}: ${cleanupErrors.map(String).join('; ')}` });
        }
        options.exit(0);
        return;
      }
      case 'start_proxy':
        try {
          await options.startProxy?.(cmd);
          if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        } catch (error) {
          options.emit({ type: 'sidecar_error', error: `Failed to start proxy: ${String(error)}` });
        }
        return;
      case 'stop_proxy':
        try {
          await options.stopProxy();
          if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        } catch (error) {
          options.emit({ type: 'sidecar_error', error: `Failed to stop proxy: ${String(error)}` });
        }
        return;
      case 'proxy_status':
        if (options.getProxyStatus) options.emit({ type: 'proxy_status', ...options.getProxyStatus() });
        return;
    }
  };

  return { dispatch };
}

async function main(): Promise<void> {
  // ADR 0005: CodeMUX sessions inject credentials via ensure_session.
  // Do not preload ~/.claude/settings.json into process.env for hosted chats.

  emit({ type: 'sidecar_ready' });

  const rl = readline.createInterface({ input: process.stdin });
  const dispatcher = createSidecarCommandDispatcher({
    claudeRuntime: runtime,
    codexRuntime,
    createOpenCodeRuntime: createOpenCodeSidecarRuntime,
    createPiRuntime: createPiSidecarRuntime,
    emit,
    startProxy: (cmd) => proxyManager.start(cmd.apiKey, cmd.baseUrl, cmd.providerName, cmd.codexNeedsProxy),
    stopProxy: () => proxyManager.stop(),
    getProxyStatus: () => proxyManager.getStatus(),
    exit: (code) => process.exit(code),
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let cmd: SidecarCommand;
    try {
      cmd = JSON.parse(trimmed) as SidecarCommand;
    } catch {
      emit({ type: 'sidecar_error', error: `Invalid JSON: ${trimmed}` });
      continue;
    }

    await dispatcher.dispatch(cmd);
  }
}

if (isSidecarEntrypoint(process.argv[1])) {
  main().catch((err) => {
    emit({ type: 'sidecar_error', error: `Fatal: ${String(err)}` });
    process.exit(1);
  });
}
