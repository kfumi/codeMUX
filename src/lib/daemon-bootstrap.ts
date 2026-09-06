import { daemonFacade } from './facades/daemon-facade';
import { createLogger } from './logger';

const logger = createLogger('daemon-bootstrap');

let started = false;

export async function initDaemonClient(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await daemonFacade.ensureClient();
    logger.info('Desktop daemon client connected');
  } catch (error) {
    logger.warn('Desktop daemon client not ready', { error: String(error) });
  }
}

export function getDaemonStartupError(): string | null {
  return daemonFacade.getInitError();
}
