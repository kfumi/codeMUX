import type { AgentKind } from '../../../types/session';
import type {
  ImportCandidate,
  ImportSessionsRequest,
  ImportSessionsResult,
} from '../../../types/historyImport';
import { ensureDaemonClient } from './lifecycle';

/** 历史会话发现与导入。 */
export const historyImport = {
  discover: async (agentKind?: AgentKind): Promise<ImportCandidate[]> => {
    const client = await ensureDaemonClient();
    return client.discoverHistoryImportCandidates(agentKind) as Promise<ImportCandidate[]>;
  },
  import: async (request: ImportSessionsRequest): Promise<ImportSessionsResult> => {
    const client = await ensureDaemonClient();
    // `ImportSessionsRequest` is an interface, so it has no implicit index
    // signature; spread it into a plain record for the transport layer.
    return client.importHistorySessions({ ...request }) as Promise<ImportSessionsResult>;
  },
};

export type HistoryImportDomain = typeof historyImport;
