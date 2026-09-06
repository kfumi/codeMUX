/**
 * Invoke-backed implementation used during facade migration (issue 01).
 * Methods are removed as each capability moves to the Daemon Client (issue 12).
 */
export {
  sessionApi,
  agentApi,
  projectApi,
  configApi,
  fileApi,
  gitApi,
  terminalApi,
  mcpApi,
  skillApi,
  scheduledTaskApi,
  historyImportApi,
  companionApi,
  usageApi,
  appApi,
  browserApi,
} from '../tauri';
