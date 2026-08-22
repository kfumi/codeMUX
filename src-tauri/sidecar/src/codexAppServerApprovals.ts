// Codex App Server Interactive Request bridge — Issue 05.
//
// Bridges server-initiated app-server requests (command execution approvals,
// file change approvals, permission profile escalations, tool user-input
// questions and MCP elicitations) onto the CodeMUX Interactive Request model:
// approvals surface as `permission_requested` (PermissionApprovalCard) and
// questions surface as `user_input_requested` (AskUserQuestionCard).
//
// While any request is pending the owning runtime must suspend its idle guard
// (ADR 0004) so waiting for the user is not mistaken for an engine stall.
// URL-mode elicitations and forms whose required fields cannot be projected
// onto the option-based question UI are strategically declined.

import type {
  AppServerRequestResponder,
  AppServerTransport,
} from './appServerTransport.js';
import type { CodeMuxQuestion } from './codeMuxProtocol.js';
import type { OpenCodePermissionResponse } from './opencodePermissions.js';

const APPROVAL_METHOD_COMMAND_V2 = 'item/commandExecution/requestApproval';
const APPROVAL_METHOD_COMMAND_V1 = 'execCommandApproval';
const APPROVAL_METHOD_FILE_CHANGE_V2 = 'item/fileChange/requestApproval';
const APPROVAL_METHOD_FILE_CHANGE_V1 = 'applyPatchApproval';
const APPROVAL_METHOD_USER_INPUT = 'item/tool/requestUserInput';
const APPROVAL_METHOD_ELICITATION = 'mcpServer/elicitation/request';
const APPROVAL_METHOD_PERMISSIONS = 'item/permissions/requestApproval';

/** Marker the AskUserQuestionCard sends when the user cancels the card. */
const USER_CANCELLED_MARKER = '__cancelled__';

export type CodexPermissionRequestProjection = {
  requestId: string;
  permissionType: string;
  description: string;
  metadata?: Record<string, unknown>;
};

export type CodexUserInputProjection = {
  requestId: string;
  questions: CodeMuxQuestion[];
};

export type CodexApprovalBridgeOptions = {
  emitPermissionRequest: (projection: CodexPermissionRequestProjection) => void;
  emitUserInputRequest: (projection: CodexUserInputProjection) => void;
  /** Called whenever the pending count changes; 0 means none outstanding. */
  onPendingChange?: (pendingCount: number) => void;
};

/** Wire shape family a pending request responds with. */
type ResponseFamily =
  | 'v2Decision'
  | 'v1ReviewDecision'
  | 'elicitation'
  | 'userInput'
  | 'permissionGrant';

type PendingRequest = {
  requestId: string;
  family: ResponseFamily;
  params: Record<string, unknown>;
  /** Codex question ids, zipped positionally with the emitted questions. */
  questionIds?: string[];
  /** Elicitation form fields, zipped positionally with the emitted questions. */
  elicitationFields?: Array<{ name: string; multiSelect: boolean }>;
  respond: AppServerRequestResponder;
};

type NormalizedPermissionDecision = 'accept' | 'acceptForSession' | 'decline';

export class CodexAppServerApprovalBridge {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: CodexApprovalBridgeOptions) {}

  register(transport: AppServerTransport): void {
    transport.handleRequest(APPROVAL_METHOD_COMMAND_V2, (params, respond) => {
      this.handleCommandApproval(params, respond, APPROVAL_METHOD_COMMAND_V2);
    });
    transport.handleRequest(APPROVAL_METHOD_COMMAND_V1, (params, respond) => {
      this.handleCommandApproval(params, respond, APPROVAL_METHOD_COMMAND_V1);
    });
    transport.handleRequest(APPROVAL_METHOD_FILE_CHANGE_V2, (params, respond) => {
      this.handleFileChangeApproval(params, respond, APPROVAL_METHOD_FILE_CHANGE_V2);
    });
    transport.handleRequest(APPROVAL_METHOD_FILE_CHANGE_V1, (params, respond) => {
      this.handleFileChangeApproval(params, respond, APPROVAL_METHOD_FILE_CHANGE_V1);
    });
    transport.handleRequest(APPROVAL_METHOD_USER_INPUT, (params, respond) => {
      this.handleUserInput(params, respond);
    });
    transport.handleRequest(APPROVAL_METHOD_ELICITATION, (params, respond) => {
      this.handleElicitation(params, respond);
    });
    transport.handleRequest(APPROVAL_METHOD_PERMISSIONS, (params, respond) => {
      this.handlePermissionGrant(params, respond);
    });
  }

  async respondToPermission(requestId: string, response: OpenCodePermissionResponse): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error(`Codex permission request ${requestId} is no longer pending`);
    }
    const decision = normalizePermissionDecision(response);
    this.removePending(requestId);
    process.stderr.write(
      `[codex-app-server] Approval ${requestId} responded: ${decision}\n`,
    );
    pending.respond({ result: buildDecisionPayload(pending, decision) });
  }

  async respondToQuestion(requestId: string, answers: string[][]): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error(`Codex question request ${requestId} is no longer pending`);
    }
    this.removePending(requestId);
    const normalized = answers.map((answer) =>
      answer.filter((value) => value !== USER_CANCELLED_MARKER),
    );
    const cancelled = normalized.every((answer) => answer.length === 0);

    if (pending.family === 'elicitation') {
      if (cancelled) {
        pending.respond({ result: { action: 'cancel' } });
        return;
      }
      const content: Record<string, unknown> = {};
      (pending.elicitationFields ?? []).forEach((field, index) => {
        const answer = normalized[index] ?? [];
        content[field.name] = field.multiSelect ? answer : answer[0];
      });
      pending.respond({ result: { action: 'accept', content } });
      return;
    }

    if (pending.family === 'userInput') {
      if (cancelled) {
        pending.respond({ result: { answers: {} } });
        return;
      }
      const payload: Record<string, unknown> = {};
      (pending.questionIds ?? []).forEach((id, index) => {
        payload[id] = { answers: normalized[index] ?? [] };
      });
      pending.respond({ result: { answers: payload } });
      return;
    }

    // Non-question families reached through the question path — cancel them.
    pending.respond({ result: buildCancelPayload(pending) });
  }

  isPendingQuestion(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    return pending?.family === 'userInput' || pending?.family === 'elicitation';
  }

  /** Responds `cancel` to every outstanding request (user interrupt / teardown). */
  cancelAll(): void {
    for (const [requestId, pending] of [...this.pending]) {
      this.pending.delete(requestId);
      process.stderr.write(`[codex-app-server] Approval ${requestId} cancelled\n`);
      pending.respond({ result: buildCancelPayload(pending) });
    }
    this.notifyPendingChange();
  }

  /** Drops all pending entries without responding (connection is gone). */
  dispose(): void {
    this.pending.clear();
    this.notifyPendingChange();
  }

  // ---------------------------------------------------------------------------
  // Request handlers
  // ---------------------------------------------------------------------------

  private handleCommandApproval(
    params: Record<string, unknown>,
    respond: AppServerRequestResponder,
    method: string,
  ): void {
    const family: ResponseFamily = method === APPROVAL_METHOD_COMMAND_V1
      ? 'v1ReviewDecision'
      : 'v2Decision';
    const command = method === APPROVAL_METHOD_COMMAND_V1
      ? (Array.isArray(params.command)
        ? params.command.filter((part): part is string => typeof part === 'string').join(' ')
        : readString(params.command) ?? '')
      : readString(params.command) ?? '';
    const cwd = readString(params.cwd) ?? undefined;
    const reason = readString(params.reason) ?? undefined;
    this.emitPermission(
      { requestId: crypto.randomUUID(), family, params, respond },
      'execute',
      reason ?? 'Codex 请求执行命令',
      {
        title: '运行命令',
        command,
        ...(cwd ? { cwd } : {}),
      },
    );
  }

  private handleFileChangeApproval(
    params: Record<string, unknown>,
    respond: AppServerRequestResponder,
    method: string,
  ): void {
    const family: ResponseFamily = method === APPROVAL_METHOD_FILE_CHANGE_V1
      ? 'v1ReviewDecision'
      : 'v2Decision';
    const reason = readString(params.reason) ?? undefined;
    const paths = method === APPROVAL_METHOD_FILE_CHANGE_V1 && isRecord(params.fileChanges)
      ? Object.keys(params.fileChanges)
      : [];
    const grantRoot = readString(params.grantRoot);
    const primaryPath = grantRoot ?? paths[0];
    this.emitPermission(
      { requestId: crypto.randomUUID(), family, params, respond },
      'write',
      reason ?? 'Codex 请求修改文件',
      {
        title: '修改文件',
        ...(primaryPath ? { path: primaryPath } : {}),
        ...(paths.length > 1 ? { patterns: paths } : {}),
      },
    );
  }

  private handlePermissionGrant(
    params: Record<string, unknown>,
    respond: AppServerRequestResponder,
  ): void {
    const reason = readString(params.reason) ?? undefined;
    const permissions = isRecord(params.permissions) ? params.permissions : {};
    const fileSystem = isRecord(permissions.fileSystem) ? permissions.fileSystem : null;
    const roots = [
      ...(fileSystem && Array.isArray(fileSystem.read)
        ? fileSystem.read.filter((root): root is string => typeof root === 'string')
        : []),
      ...(fileSystem && Array.isArray(fileSystem.write)
        ? fileSystem.write.filter((root): root is string => typeof root === 'string')
        : []),
    ];
    this.emitPermission(
      { requestId: crypto.randomUUID(), family: 'permissionGrant', params, respond },
      'external_directory',
      reason ?? 'Codex 请求提升权限配置',
      {
        title: '访问外部目录',
        ...(roots.length ? { path: roots[0], patterns: roots } : {}),
      },
    );
  }

  private handleUserInput(
    params: Record<string, unknown>,
    respond: AppServerRequestResponder,
  ): void {
    const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
    const questions: CodeMuxQuestion[] = [];
    const questionIds: string[] = [];
    for (const raw of rawQuestions) {
      if (!isRecord(raw)) continue;
      const id = readString(raw.id);
      const question = readString(raw.question);
      if (id === null || question === null) continue;
      const options = Array.isArray(raw.options)
        ? raw.options
          .filter(isRecord)
          .map((option) => {
            const label = readString(option.label) ?? '';
            const description = readString(option.description);
            return { label, ...(description !== null ? { description } : {}) };
          })
          .filter((option) => option.label)
        : [];
      questionIds.push(id);
      const header = readString(raw.header);
      questions.push({
        question,
        ...(header !== null ? { header } : {}),
        options,
      });
    }
    if (!questions.length) {
      respond({ result: { answers: {} } });
      return;
    }
    const requestId = crypto.randomUUID();
    this.addPending({ requestId, family: 'userInput', params, questionIds, respond });
    process.stderr.write(
      `[codex-app-server] User input request pending as ${requestId} (${questions.length} question(s))\n`,
    );
    this.options.emitUserInputRequest({ requestId, questions });
  }

  private handleElicitation(
    params: Record<string, unknown>,
    respond: AppServerRequestResponder,
  ): void {
    const mode = readString(params.mode);
    const message = readString(params.message) ?? '';
    if (mode !== 'form') {
      // URL-mode elicitations have no faithful desktop projection — decline
      // strategically so the MCP tool call can continue.
      process.stderr.write(
        `[codex-app-server] Elicitation mode=${mode ?? 'unknown'} declined strategically\n`,
      );
      respond({ result: { action: 'decline' } });
      return;
    }

    const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
    const properties = schema && isRecord(schema.properties) ? schema.properties : null;
    const required = schema && Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [];
    if (!properties) {
      respond({ result: { action: 'decline' } });
      return;
    }

    const fields: Array<{ name: string; multiSelect: boolean }> = [];
    const questions: CodeMuxQuestion[] = [];
    for (const [name, rawSchema] of Object.entries(properties)) {
      if (!isRecord(rawSchema)) continue;
      const field = parseElicitationEnumField(rawSchema);
      if (!field) {
        if (required.includes(name)) {
          // Required free-text/number/boolean fields cannot be projected onto
          // the option-based question UI — decline the whole form.
          process.stderr.write(
            `[codex-app-server] Elicitation field ${name} is not projectable; declining\n`,
          );
          respond({ result: { action: 'decline' } });
          return;
        }
        continue;
      }
      const title = readString(rawSchema.title) ?? name;
      const description = readString(rawSchema.description);
      fields.push({ name, multiSelect: field.multiSelect });
      questions.push({
        question: questions.length === 0 && message ? `${message}\n${title}` : title,
        ...(description !== null ? { header: description } : {}),
        options: field.options.map((option) => ({
          label: option.label,
          value: option.value,
        })),
        ...(field.multiSelect ? { multiSelect: true } : {}),
      });
    }

    if (!questions.length) {
      respond({ result: { action: 'decline' } });
      return;
    }

    const requestId = crypto.randomUUID();
    this.addPending({ requestId, family: 'elicitation', params, elicitationFields: fields, respond });
    process.stderr.write(
      `[codex-app-server] Elicitation form pending as ${requestId} (${fields.length} field(s))\n`,
    );
    this.options.emitUserInputRequest({ requestId, questions });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private emitPermission(
    entry: { requestId: string; family: ResponseFamily; params: Record<string, unknown>; respond: AppServerRequestResponder },
    permissionType: string,
    description: string,
    metadata: Record<string, unknown>,
  ): void {
    this.addPending(entry);
    process.stderr.write(
      `[codex-app-server] Approval request ${permissionType} pending as ${entry.requestId}\n`,
    );
    this.options.emitPermissionRequest({
      requestId: entry.requestId,
      permissionType,
      description,
      metadata,
    });
  }

  private addPending(entry: PendingRequest): void {
    this.pending.set(entry.requestId, entry);
    this.notifyPendingChange();
  }

  private removePending(requestId: string): void {
    this.pending.delete(requestId);
    this.notifyPendingChange();
  }

  private notifyPendingChange(): void {
    this.options.onPendingChange?.(this.pending.size);
  }
}

// ---------------------------------------------------------------------------
// Decision payload builders
// ---------------------------------------------------------------------------

function normalizePermissionDecision(response: OpenCodePermissionResponse): NormalizedPermissionDecision {
  if (response === 'once') return 'accept';
  if (response === 'always') return 'acceptForSession';
  if (response === 'reject') return 'decline';
  if (typeof response === 'object' && response !== null) {
    if (response.approved === false) return 'decline';
    if (response.always) return 'acceptForSession';
    return 'accept';
  }
  return 'accept';
}

function buildDecisionPayload(
  pending: PendingRequest,
  decision: NormalizedPermissionDecision,
): unknown {
  switch (pending.family) {
    case 'v2Decision':
      return { decision };
    case 'v1ReviewDecision':
      switch (decision) {
        case 'accept':
          return { decision: 'approved' };
        case 'acceptForSession':
          return { decision: 'approved_for_session' };
        case 'decline':
          return { decision: { denied: { rejection: '用户拒绝了该请求' } } };
      }
      return { decision: { denied: { rejection: '用户拒绝了该请求' } } };
    case 'elicitation':
      // Elicitations are answered through the question path; a permission
      // response here is a mismatch — decline is the safe outcome.
      return { action: 'decline' };
    case 'permissionGrant':
      if (decision === 'decline') {
        return { permissions: {} };
      }
      return {
        permissions: isRecord(pending.params.permissions) ? pending.params.permissions : {},
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    case 'userInput':
      // Question requests are answered through respondToQuestion; a permission
      // response here is a mismatch — cancel with no answers.
      return { answers: {} };
  }
}

function buildCancelPayload(pending: PendingRequest): unknown {
  switch (pending.family) {
    case 'v2Decision':
      return { decision: 'cancel' };
    case 'v1ReviewDecision':
      return { decision: 'abort' };
    case 'elicitation':
      return { action: 'cancel' };
    case 'userInput':
      return { answers: {} };
    case 'permissionGrant':
      return { permissions: {} };
  }
}

// ---------------------------------------------------------------------------
// Elicitation form parsing
// ---------------------------------------------------------------------------

type ElicitationEnumField = {
  multiSelect: boolean;
  options: Array<{ label: string; value: string }>;
};

/**
 * Parses an elicitation schema property into option-backed question data.
 * Returns null for non-enum fields (free text, numbers, booleans).
 */
function parseElicitationEnumField(schema: Record<string, unknown>): ElicitationEnumField | null {
  const type = readString(schema.type);

  if (type === 'string') {
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.filter((value): value is string => typeof value === 'string');
      if (!values.length) return null;
      const names = Array.isArray(schema.enumNames)
        ? schema.enumNames.map((name) => (typeof name === 'string' ? name : null))
        : [];
      return {
        multiSelect: false,
        options: values.map((value, index) => ({ label: names[index] ?? value, value })),
      };
    }
    if (Array.isArray(schema.oneOf)) {
      const options = parseTitledEnumOptions(schema.oneOf);
      if (options.length) return { multiSelect: false, options };
    }
    return null;
  }

  if (type === 'array' && isRecord(schema.items)) {
    const items = schema.items;
    if (Array.isArray(items.enum)) {
      const values = items.enum.filter((value): value is string => typeof value === 'string');
      if (!values.length) return null;
      return { multiSelect: true, options: values.map((value) => ({ label: value, value })) };
    }
    if (Array.isArray(items.anyOf)) {
      const options = parseTitledEnumOptions(items.anyOf);
      if (options.length) return { multiSelect: true, options };
    }
  }

  return null;
}

function parseTitledEnumOptions(rawOptions: unknown[]): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  for (const raw of rawOptions) {
    if (!isRecord(raw)) continue;
    const value = readString(raw.const);
    if (value === null) continue;
    options.push({ label: readString(raw.title) ?? value, value });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
