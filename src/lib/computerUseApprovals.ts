/**
 * 电脑控制审批（工单 03）：daemon 侧闸门发起的放行请求。
 *
 * 与既有 `AgentPermissionRequest` 的区别：那是各智能体原生权限门的请求
 * （问「这个工具能不能用」），这是 CodeMUX 自己的粒度闸门（问「这一步能不能
 * 做」）。两者都在会话输入框上方渲染，但应答端点不同。
 */

/** daemon 的风险分级（serde camelCase）。 */
export type ComputerUseRisk = 'readOnly' | 'input';

export interface ComputerUseApprovalRequest {
  request_id: string;
  session_id?: string;
  tool: string;
  op: string;
  /** 一句话动作摘要（daemon 生成，输入内容已脱敏）。 */
  summary: string;
  risk: ComputerUseRisk;
  /** 命中的敏感场景（登录/支付/验证码/密码/删除/关闭防护）。 */
  sensitive?: string | null;
  /** 界面是否提供「本会话记住」（只读）。 */
  rememberable: boolean;
  /**
   * 输入动作的限时授权（工单 13）：daemon 给出时长，界面据此提供
   * 「允许 N 分钟」——授权只在当前回合作数，到期或被 Esc 收回即失效。
   */
  grant?: { ttlSeconds: number; scope?: string } | null;
  /** 已脱敏的参数。 */
  params?: Record<string, unknown>;
}

export type ComputerUseApprovalChoice = 'once' | 'always' | 'reject';

export interface ComputerUseApprovalOption {
  choice: ComputerUseApprovalChoice;
  label: string;
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 解析 daemon 广播的审批事件；不是审批事件返回 null。 */
export function parseComputerUseApprovalEvent(
  raw: unknown,
):
  | { kind: 'request'; request: ComputerUseApprovalRequest }
  | { kind: 'resolved'; requestId: string }
  | null {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!isRecord(value)) return null;
  const requestId = readString(value, 'requestId');
  if (!requestId) return null;

  if (value.type === 'computer-use-approval-resolved') {
    return { kind: 'resolved', requestId };
  }
  if (value.type !== 'computer-use-approval-request') return null;

  const risk: ComputerUseRisk = value.risk === 'readOnly' ? 'readOnly' : 'input';
  return {
    kind: 'request',
    request: {
      request_id: requestId,
      session_id: readString(value, 'sessionId'),
      tool: readString(value, 'tool') ?? 'computer-use',
      op: readString(value, 'op') ?? 'unknown',
      summary: readString(value, 'summary') ?? '电脑控制操作',
      risk,
      sensitive: readString(value, 'sensitive') ?? null,
      rememberable: value.rememberable === true,
      grant: readGrant(value.grant),
      params: isRecord(value.params) ? value.params : undefined,
    },
  };
}

/** 限时授权字段：时长为正的整数才认（daemon 不给就当没有这个选项）。 */
function readGrant(raw: unknown): ComputerUseApprovalRequest['grant'] {
  if (!isRecord(raw)) return null;
  const ttlSeconds = raw.ttlSeconds;
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return null;
  }
  return {
    ttlSeconds: Math.floor(ttlSeconds),
    scope: readString(raw, 'scope'),
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 入队（同一个 requestId 不重复入队：重连回放会重发同一事件）。 */
export function enqueueComputerUseApproval(
  list: ComputerUseApprovalRequest[],
  request: ComputerUseApprovalRequest,
): ComputerUseApprovalRequest[] {
  if (list.some((item) => item.request_id === request.request_id)) return list;
  return [...list, request];
}

export function dequeueComputerUseApproval(
  list: ComputerUseApprovalRequest[],
  requestId: string,
): ComputerUseApprovalRequest[] {
  const next = list.filter((item) => item.request_id !== requestId);
  return next.length === list.length ? list : next;
}

/**
 * 粒度选项（需求 18、23；工单 13 补限时授权）：
 * - 只读且 daemon 允许记住 → 放行 / 本会话记住 / 拦截；
 * - 输入动作带限时授权 → 放行 / 允许 N 分钟 / 拦截（授权限时、限本回合，
 *   敏感场景不出现这个选项，受保护目标也不在授权范围内）；
 * - 敏感场景 → 只有单步放行与拦截。
 */
export function computerUseApprovalOptions(
  request: ComputerUseApprovalRequest,
): ComputerUseApprovalOption[] {
  const options: ComputerUseApprovalOption[] = [];
  if (request.risk === 'readOnly' && request.rememberable) {
    options.push({
      choice: 'once',
      label: '放行',
      description: '只允许这一次。',
    });
    options.push({
      choice: 'always',
      label: '本会话记住',
      description: '本会话内同类的只读操作不再询问。',
    });
  } else {
    options.push({
      choice: 'once',
      label: '放行',
      description: request.sensitive
        ? '只允许这一次；敏感场景每一步都要确认。'
        : '只允许这一次；输入动作每次都询问。',
    });
    if (!request.sensitive && request.grant) {
      const minutes = Math.max(1, Math.round(request.grant.ttlSeconds / 60));
      options.push({
        choice: 'always',
        label: `允许 ${minutes} 分钟`,
        description: `本回合内的输入动作不再逐次询问；到期、本回合结束或按 Esc 都会失效，敏感场景仍然逐次确认。`,
      });
    }
  }
  options.push({
    choice: 'reject',
    label: '拦截',
    description: '拒绝这一步，并把结果告诉智能体。',
  });
  return options;
}

/** 卡片副标题：说清这一步是什么、为什么被拦下问人。 */
export function computerUseApprovalReason(request: ComputerUseApprovalRequest): string {
  if (request.sensitive) {
    return `敏感场景（${request.sensitive}）需要你确认后才能继续。`;
  }
  if (request.risk === 'input') {
    return request.grant
      ? '输入动作会改变系统状态，需要你放行；也可以给本回合几分钟的授权。'
      : '输入动作会改变页面或系统状态，需要你放行。';
  }
  return '只读观测需要你确认（可本会话记住）。';
}
