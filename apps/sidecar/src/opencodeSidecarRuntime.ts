import { normalizeOpenCodeModelReference } from './opencodeSdk.js';
import { ensureWorkingDirectory } from './defaultWorkingDirectory.js';
import { emit, syncStreamSessionContext } from './streamEventBatcher.js';
import { OpenCodeRuntime } from './opencodeRuntime.js';
import type { EnsureSessionCommand, OpenCodeSessionConfig, OpenCodeSessionMapping } from './types.js';
import type { SidecarRuntime } from './runtimePort.js';

export function buildOpenCodeSessionMappingEvent(mapping: OpenCodeSessionMapping): {
  type: 'agent_session_mapping';
  app_session_id: string;
  agent_kind: 'opencode';
  agent_session_id: string;
  runtime_generation: number;
} {
  return {
    type: 'agent_session_mapping',
    app_session_id: mapping.sessionId,
    agent_kind: 'opencode',
    agent_session_id: mapping.agentSessionId,
    runtime_generation: mapping.runtimeGeneration,
  };
}

function buildOpenCodeSessionConfig(cmd: EnsureSessionCommand): OpenCodeSessionConfig {
  const modelReference = cmd.model?.startsWith('opencode/')
    ? normalizeOpenCodeModelReference(cmd.model)
    : cmd.provider
      ? { provider: cmd.provider, model: cmd.model ?? 'default' }
      : normalizeOpenCodeModelReference(cmd.model ?? 'default');
  return {
    cwd: ensureWorkingDirectory(cmd.cwd),
    sessionId: cmd.sessionId ?? crypto.randomUUID(),
    ...(cmd.agentSessionId ? { agentSessionId: cmd.agentSessionId } : {}),
    runtimeGeneration: cmd.runtimeGeneration ?? 0,
    provider: modelReference.provider,
    model: modelReference.model,
    credentialSource: cmd.credentialSource ?? 'none',
    ...(cmd.credentialSource === 'codemux' && cmd.apiKey ? { apiKey: cmd.apiKey } : {}),
    ...(cmd.baseUrl ? { baseUrl: cmd.baseUrl } : {}),
    ...(cmd.runtimeRef ? { runtimeRef: cmd.runtimeRef } : {}),
    ...(cmd.timeouts ? { timeouts: cmd.timeouts } : {}),
    ...(cmd.modelLimits ? { modelLimits: cmd.modelLimits } : {}),
    ...(cmd.mcpServers ? { mcpServers: cmd.mcpServers } : {}),
    ...(cmd.additionalDirectories?.length
      ? { additionalDirectories: cmd.additionalDirectories }
      : {}),
  };
}

export function createOpenCodeSidecarRuntime(cmd: EnsureSessionCommand): SidecarRuntime {
  const config = buildOpenCodeSessionConfig(cmd);
  syncStreamSessionContext({
    appSessionId: config.sessionId,
    ...(config.agentSessionId ? { providerSessionId: config.agentSessionId } : {}),
  });
  const openCodeRuntime = new OpenCodeRuntime(config);
  if (cmd.planMode === 'on' || cmd.planMode === 'off') {
    openCodeRuntime.updatePermissions({ permissionConfig: cmd.permissionConfig, planMode: cmd.planMode });
  } else if (cmd.permissionConfig) {
    openCodeRuntime.updatePermissions({ permissionConfig: cmd.permissionConfig });
  }
  return {
    ensure: async () => {
      const mapping = await openCodeRuntime.start();
      emit(buildOpenCodeSessionMappingEvent(mapping));
    },
    emitSessionMapping: (cmd) => {
      if (!openCodeRuntime.isStarted()) {
        return;
      }
      emit(buildOpenCodeSessionMappingEvent(
        openCodeRuntime.buildSessionMapping(cmd.runtimeGeneration ?? 0),
      ));
    },
    canReuse: (nextCmd) => openCodeRuntime.canReuse(buildOpenCodeSessionConfig(nextCmd)),
    sendInput: (prompt, inputPayload) => openCodeRuntime.sendInput(prompt, inputPayload),
    steerActiveTurn: (prompt, inputPayload) => openCodeRuntime.steerActiveTurn(prompt, inputPayload),
    updatePermissions: (update) => openCodeRuntime.updatePermissions(update),
    forkSession: (
      sourceAgentSessionId,
      sourceProviderTurnId,
      sourceProviderTurnOrdinal,
      sourceProviderMessageId,
    ) => openCodeRuntime.forkSession(
      sourceAgentSessionId,
      sourceProviderTurnId,
      sourceProviderTurnOrdinal,
      sourceProviderMessageId,
    ),
    rewindConversation: (input) =>
      openCodeRuntime.rewindConversation({ providerMessageId: input.providerMessageId ?? '' }),
    resetSession: () => openCodeRuntime.resetSession(),
    deleteSession: (agentSessionId) => openCodeRuntime.deleteSession(agentSessionId),
    interrupt: () => openCodeRuntime.interrupt(),
    shutdown: () => openCodeRuntime.shutdown(),
    respondToPermission: (requestId, response, sessionId) => openCodeRuntime.respondToPermission(requestId, response, sessionId),
    respondToQuestion: (requestId, answers) => openCodeRuntime.respondToQuestion(requestId, answers),
  };
}
