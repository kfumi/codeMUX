import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import { emit, syncStreamSessionContext } from './streamEventBatcher.js';
import { PiRuntime } from './piRuntime.js';
import type { PiApprovalMode } from './piExtension.js';
import type { PiThinkingLevel } from './piEvents.js';
import type { SidecarPermissionConfig } from './agentPermissions.js';
import type { EnsureSessionCommand, PiSessionConfig, PiSessionMapping } from './types.js';
import { normalizeToolResponseAnswers, type SidecarRuntime } from './runtimePort.js';

export function buildPiSessionMappingEvent(mapping: PiSessionMapping): {
  type: 'agent_session_mapping';
  app_session_id: string;
  agent_kind: 'pi';
  agent_session_id: string;
  runtime_generation: number;
} {
  return {
    type: 'agent_session_mapping',
    app_session_id: mapping.sessionId,
    agent_kind: 'pi',
    agent_session_id: mapping.agentSessionId,
    runtime_generation: mapping.runtimeGeneration,
  };
}

function buildPiSessionConfig(cmd: EnsureSessionCommand): PiSessionConfig {
  let provider = cmd.provider ?? undefined;
  let model = cmd.model ?? undefined;
  if (!provider && model && model.includes('/')) {
    const separatorIndex = model.indexOf('/');
    provider = model.slice(0, separatorIndex);
    model = model.slice(separatorIndex + 1);
  }
  // pi 无 'opencode' 凭据来源语义；未知值按未配置处理（不回落 pi 自身认证）。
  const credentialSource: PiSessionConfig['credentialSource'] =
    cmd.credentialSource === 'codemux' || cmd.credentialSource === 'environment'
      ? cmd.credentialSource
      : 'none';
  return {
    cwd: ensureWorkingDirectory(cmd.cwd),
    sessionId: cmd.sessionId ?? crypto.randomUUID(),
    ...(cmd.agentSessionId ? { agentSessionId: cmd.agentSessionId } : {}),
    runtimeGeneration: cmd.runtimeGeneration ?? 0,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(mapReasoningEffortToPiThinking(cmd.reasoningEffort)
      ? { thinkingLevel: mapReasoningEffortToPiThinking(cmd.reasoningEffort) }
      : {}),
    credentialSource,
    ...(credentialSource === 'codemux' && cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
    ...(cmd.baseUrl ? { baseUrl: cmd.baseUrl } : {}),
    ...(cmd.piConfigDir ? { piConfigDir: cmd.piConfigDir } : {}),
    approvalMode: resolvePiApprovalMode(cmd.permissionConfig),
    ...(cmd.modelLimits?.contextWindow && cmd.modelLimits.contextWindow > 0
      ? { modelContextWindow: cmd.modelLimits.contextWindow }
      : {}),
    ...(cmd.modelLimits?.maxTokens && cmd.modelLimits.maxTokens > 0
      ? { modelMaxTokens: cmd.modelLimits.maxTokens }
      : {}),
    ...(cmd.modelLimits?.reasoning ? { modelReasoning: true } : {}),
    ...(cmd.modelLimits?.thinkingLevelMap
      ? { modelThinkingLevelMap: cmd.modelLimits.thinkingLevelMap }
      : {}),
    ...(cmd.modelLimits?.input?.length ? { modelInputModalities: cmd.modelLimits.input } : {}),
    ...(cmd.runtimeRef ? { runtimeRef: cmd.runtimeRef } : {}),
    // pi >= 0.99 原生 MCP：daemon 下发的 mcpServers 经 PiRuntime 同步进托管目录的
    // mcp.json（用户级配置，无需项目信任；canReuse 比对触发变更后进程重建）。
    ...(cmd.mcpServers ? { mcpServers: cmd.mcpServers } : {}),
    ...(cmd.additionalDirectories?.length
      ? { additionalDirectories: cmd.additionalDirectories }
      : {}),
  };
}

/** pi 审批档位：只识别 pi kind 的配置（executionMode），其余回落 confirm_before_edit。 */
function resolvePiApprovalMode(config: SidecarPermissionConfig | undefined): PiApprovalMode {
  if (config?.kind === 'pi') {
    if (config.executionMode === 'auto_edit' || config.executionMode === 'full_access') {
      return config.executionMode;
    }
  }
  return 'confirm_before_edit';
}

/** CodeMUX reasoningEffort → pi thinking level（'none' → 'off'，缺省交给 pi 默认 medium）。 */
function mapReasoningEffortToPiThinking(effort: string | undefined): PiThinkingLevel | undefined {
  switch (effort) {
    case 'none':
      return 'off';
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined;
  }
}

export function createPiSidecarRuntime(cmd: EnsureSessionCommand): SidecarRuntime {
  const config = buildPiSessionConfig(cmd);
  syncStreamSessionContext({
    appSessionId: config.sessionId,
    ...(config.agentSessionId ? { providerSessionId: config.agentSessionId } : {}),
  });
  const piRuntime = new PiRuntime(config);
  return {
    flavor: 'pi',
    ensure: async () => {
      const mapping = await piRuntime.ensure();
      emit(buildPiSessionMappingEvent(mapping));
    },
    emitSessionMapping: (cmd) => {
      if (!piRuntime.isStarted) {
        return;
      }
      emit(buildPiSessionMappingEvent(piRuntime.buildSessionMapping(cmd.runtimeGeneration ?? 0)));
    },
    canReuse: (nextCmd) => piRuntime.canReuse(buildPiSessionConfig(nextCmd)),
    sendInput: (prompt, inputPayload) => piRuntime.sendInput(prompt, inputPayload),
    steerActiveTurn: (prompt, inputPayload) => piRuntime.steerActiveTurn(prompt, inputPayload),
    updatePermissions: () => {
      // pi 权限档位经 canReuse 比对在下一轮 ensure 重建生效（与模型/思考等级同机制），
      // 原地更新为 no-op。
    },
    respondToPermission: (requestId, response, sessionId) =>
      piRuntime.respondToPermission(requestId, response, sessionId),
    respondToQuestion: (requestId, answers) => piRuntime.respondToQuestion(requestId, answers),
    respondToToolUse: async (toolUseId, response) => {
      if (piRuntime.isPendingQuestion(toolUseId)) {
        await piRuntime.respondToQuestion(toolUseId, normalizeToolResponseAnswers(response));
        return;
      }
      throw new Error('pi tool responses are only supported while a question is pending');
    },
    forkSession: (sourceAgentSessionId) => piRuntime.forkSession(sourceAgentSessionId),
    rewindConversation: async (input) => {
      if (!input.entryId) {
        throw new Error('Pi rewind requires the tree entry id');
      }
      return piRuntime.forkToEntry(input.entryId);
    },
    resetSession: () => piRuntime.resetSession(),
    deleteSession: (agentSessionId) => piRuntime.deleteSession(agentSessionId),
    interrupt: () => piRuntime.interrupt(),
    shutdown: () => piRuntime.shutdown(),
  };
}
