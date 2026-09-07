/**
 * Capability classification for the Daemon / Shell boundary.
 * Each capability maps to exactly one facade — daemon or shell.
 */
export type FacadeOwner = 'daemon' | 'shell';

export interface CapabilityEntry {
  id: string;
  owner: FacadeOwner;
  /** Companion route when owner is daemon and protocol-backed */
  companionRoute?: string;
  /** Daemon facade method name */
  daemonMethod?: string;
  /** Shell facade method name */
  shellMethod?: string;
}

export const CAPABILITY_MANIFEST: CapabilityEntry[] = [
  // Session & Timeline
  { id: 'session.list', owner: 'daemon', companionRoute: 'GET /api/sessions', daemonMethod: 'listSessions' },
  { id: 'session.archived', owner: 'daemon', companionRoute: 'GET /api/sessions/archived', daemonMethod: 'listArchivedSessions' },
  { id: 'session.create', owner: 'daemon', companionRoute: 'POST /api/sessions', daemonMethod: 'createSession' },
  { id: 'session.import', owner: 'daemon', companionRoute: 'GET|POST /api/sessions/import', daemonMethod: 'historyImport' },
  { id: 'session.timeline', owner: 'daemon', companionRoute: 'GET /api/sessions/:id/timeline', daemonMethod: 'getTimeline' },
  { id: 'session.archive', owner: 'daemon', companionRoute: 'POST /api/sessions/:id/archive', daemonMethod: 'archiveViaDaemon' },
  { id: 'session.fork', owner: 'daemon', companionRoute: 'POST /api/sessions/:id/fork', daemonMethod: 'forkClaude' },
  { id: 'session.rewind', owner: 'daemon', companionRoute: 'POST /api/sessions/:id/rewind', daemonMethod: 'rewindSession' },
  { id: 'session.settings', owner: 'daemon', companionRoute: 'PATCH /api/sessions/:id/settings', daemonMethod: 'updateSessionSettingsViaDaemon' },

  // Agent / messaging
  { id: 'agent.send', owner: 'daemon', companionRoute: 'POST /api/sessions/:id/messages', daemonMethod: 'sendMessageViaDaemon' },
  { id: 'agent.runtime-state', owner: 'daemon', companionRoute: 'GET /api/sessions/:id/state', daemonMethod: 'isSessionTurnActive' },
  { id: 'agent.permission', owner: 'daemon', companionRoute: 'POST /api/permissions/respond', daemonMethod: 'respondToPermissionViaDaemon' },
  { id: 'agent.interactive', owner: 'daemon', companionRoute: 'POST /api/interactive/user-input', daemonMethod: 'respondToInteractiveViaDaemon' },

  // Bootstrap & projects
  { id: 'bootstrap', owner: 'daemon', companionRoute: 'GET /api/bootstrap', daemonMethod: 'getBootstrap' },
  { id: 'project.list', owner: 'daemon', companionRoute: 'GET /api/projects', daemonMethod: 'listProjects' },
  { id: 'project.create', owner: 'daemon', companionRoute: 'POST /api/projects', daemonMethod: 'createProject' },
  { id: 'project.delete', owner: 'daemon', companionRoute: 'DELETE /api/projects/:id', daemonMethod: 'deleteProject' },
  { id: 'project.rename', owner: 'daemon', companionRoute: 'PATCH /api/projects/:id', daemonMethod: 'renameProject' },

  // Config / control plane
  { id: 'config.app', owner: 'daemon', companionRoute: 'GET|PATCH /api/config', daemonMethod: 'getConfig' },
  { id: 'provider.manage', owner: 'daemon', companionRoute: 'GET|POST /api/providers', daemonMethod: 'upsertModelProvider' },
  { id: 'mcp.manage', owner: 'daemon', companionRoute: 'GET|POST /api/mcp', daemonMethod: 'mcp' },
  { id: 'skills.manage', owner: 'daemon', companionRoute: 'GET|POST /api/skills', daemonMethod: 'skills' },
  { id: 'scheduled.manage', owner: 'daemon', companionRoute: 'GET|POST /api/scheduled-tasks', daemonMethod: 'scheduledTasks' },
  { id: 'runtime.diagnostics', owner: 'daemon', companionRoute: 'GET /api/runtime/managed', daemonMethod: 'checkManagedRuntimes' },
  { id: 'runtime.manage', owner: 'daemon', companionRoute: 'GET|POST|DELETE /api/runtime/managed/*', daemonMethod: 'managedRuntime' },
  { id: 'usage.stats', owner: 'daemon', companionRoute: 'GET /api/usage/stats', daemonMethod: 'usage' },
  { id: 'workspace.files', owner: 'daemon', companionRoute: 'GET|POST /api/workspace/files', daemonMethod: 'listDirectory' },
  { id: 'workspace.git', owner: 'daemon', companionRoute: 'GET|POST /api/workspace/git', daemonMethod: 'git' },
  { id: 'terminal.pty', owner: 'daemon', companionRoute: 'WS /api/ws (terminal frames)', daemonMethod: 'terminal' },

  // Shell-only
  { id: 'browser.host', owner: 'shell', shellMethod: 'browser' },
  { id: 'dialog.file', owner: 'shell', shellMethod: 'pickFile' },
  { id: 'dialog.directory', owner: 'shell', shellMethod: 'pickDirectory' },
  { id: 'window.manage', owner: 'shell', shellMethod: 'window' },
  { id: 'tray.manage', owner: 'shell', shellMethod: 'tray' },
  { id: 'updater', owner: 'shell', shellMethod: 'updater' },
  { id: 'open.external', owner: 'shell', shellMethod: 'openExternal' },
  { id: 'browser.control', owner: 'shell', shellMethod: 'setBrowserControl' },
];

/** Methods that must route through the daemon HTTP client (no invoke fallback). */
export const PROTOCOL_BACKED_DAEMON_METHODS = [
  'listSessions',
  'listArchivedSessions',
  'listProjects',
  'createProject',
  'deleteProject',
  'renameProject',
  'getBootstrap',
  'getTimeline',
  'subscribeSession',
  'createSessionViaDaemon',
  'createSession',
  'sendMessageViaDaemon',
  'interruptViaDaemon',
  'isSessionTurnActive',
  'respondToPermissionViaDaemon',
  'respondToInteractiveViaDaemon',
  'updateSessionSettingsViaDaemon',
  'archiveViaDaemon',
  'unarchiveViaDaemon',
  'patchSessionViaDaemon',
  'setPinned',
  'setReadOnly',
  'updateTitle',
  'forkClaudeViaDaemon',
  'forkClaude',
  'rewindSession',
  'deleteSession',
  'forkCodex',
  'forkOpenCode',
  'forkPi',
  'updateWorkingPath',
  'touchSession',
  'updateProvider',
  'updateReasoningEffort',
  'updatePermissions',
  'resyncSessionFromNative',
  'readFile',
  'writeFile',
  'deleteFile',
  'listDirectory',
  'checkManagedRuntimes',
  'setActiveProvider',
  'upsertModelProvider',
  'deleteModelProvider',
  'setModelProviderEnabled',
  'listBuiltinProviderTemplates',
  'instantiateBuiltinProviderTemplate',
  'testModelProvider',
  'providerUsableForAgent',
  'ensureAgentSession',
  'enrichAttachments',
  'getSessionInfo',
  'loadLatestTokenUsage',
  'loadSessionSubagents',
  'interruptAgent',
  'respondToAgentPermission',
  'sendToolResponse',
  'resetAgentSession',
  'shutdownAgent',
  'historyImport',
  'getConfig',
  'setTheme',
  'setCompactAiOutput',
  'setImmediateRunMode',
  'setAttachmentEnrichment',
  'setNotificationSettings',
  'setGitSettings',
  'setDefaultOpenTarget',
  'setDefaultAgentKind',
  'updateAgentConfig',
  'deleteClaudeSessionFiles',
  'deleteCodexSessionFiles',
  'deleteOpenCodeSession',
  'loadSessionEvents',
  'fetchProviderModels',
  'fetchOpenCodeFreeModels',
] as const;

export const DAEMON_CAPABILITIES = CAPABILITY_MANIFEST.filter((entry) => entry.owner === 'daemon');
export const SHELL_CAPABILITIES = CAPABILITY_MANIFEST.filter((entry) => entry.owner === 'shell');

/** Methods that must never appear on the shell facade */
export const FORBIDDEN_SHELL_METHODS = [
  'sendMessage',
  'sendInput',
  'interruptSession',
  'respondToPermission',
  'respondToInteractive',
  'startAgentSession',
] as const;
