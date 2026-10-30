import type { TerminalEvent } from '../../daemon-client/terminal';
import { ensureDaemonClient } from './lifecycle';

/** PTY 终端会话。 */
export const terminal = {
  start: async (
    projectPath: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ) => (await ensureDaemonClient()).terminalStart(projectPath, cols, rows, onEvent),
  attach: async (
    terminalId: string,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ) => (await ensureDaemonClient()).terminalAttach(terminalId, cols, rows, onEvent),
  detach: async (terminalId: string) => (await ensureDaemonClient()).terminalDetach(terminalId),
  write: async (terminalId: string, data: string) =>
    (await ensureDaemonClient()).terminalWrite(terminalId, data),
  resize: async (terminalId: string, cols: number, rows: number) =>
    (await ensureDaemonClient()).terminalResize(terminalId, cols, rows),
  close: async (terminalId: string) => (await ensureDaemonClient()).terminalClose(terminalId),
};

export type TerminalDomain = typeof terminal;
export type { TerminalEvent };
