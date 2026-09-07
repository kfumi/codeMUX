import { catchUpTimelineAfterSequence } from './daemon-session-bridge';
import { createLogger } from './logger';

const logger = createLogger('companionStreamBridge');

/** @deprecated Mobile-origin stream hints now use Daemon WS catch-up instead of Tauri IPC. */
export function initCompanionStreamBridge() {
  logger.info('Companion stream bridge uses daemon WS catch-up; Tauri IPC listener disabled');
  void catchUpTimelineAfterSequence;
}
