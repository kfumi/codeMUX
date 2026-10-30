import { ensureDaemonClient, resetDaemonClient } from './lifecycle';
import { session } from './session';
import { timeline } from './timeline';
import { project } from './project';
import { git } from './git';
import { provider } from './provider';
import { config } from './config';
import { workspace } from './workspace';
import { terminal } from './terminal';
import { mcp } from './mcp';
import { skills } from './skills';
import { scheduledTasks } from './scheduledTasks';
import { workTasks } from './workTasks';
import { historyImport } from './historyImport';
import { usage } from './usage';
import { runtime } from './runtime';
import { computerUse } from './computerUse';
import { companion } from './companion';

/**
 * Daemon 门面:对外只出域,不镜像路由。
 * 单例生命周期在 lifecycle,各域实现与传输细节都在各自 module 里。
 */
export const daemonFacade = {
  ensureClient: ensureDaemonClient,
  resetClient: resetDaemonClient,
  getBootstrap: async () => (await ensureDaemonClient()).getBootstrap(),

  session,
  timeline,
  project,
  git,
  provider,
  config,
  workspace,
  terminal,
  mcp,
  skills,
  scheduledTasks,
  workTasks,
  historyImport,
  usage,
  runtime,
  computerUse,
  companion,
};

export type DaemonFacade = typeof daemonFacade;

export { ensureDaemonClient, resetDaemonClient };
