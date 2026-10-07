import { describe, expect, it } from 'vitest';

import {
  computerUseApprovalOptions,
  computerUseApprovalReason,
  dequeueComputerUseApproval,
  enqueueComputerUseApproval,
  parseComputerUseApprovalEvent,
  type ComputerUseApprovalRequest,
} from './computerUseApprovals';

function request(overrides: Partial<ComputerUseApprovalRequest> = {}): ComputerUseApprovalRequest {
  return {
    request_id: 'req-1',
    session_id: 'session-1',
    tool: 'browser_click',
    op: 'click',
    summary: '点击元素 e3',
    risk: 'input',
    sensitive: null,
    rememberable: false,
    ...overrides,
  };
}

describe('parseComputerUseApprovalEvent', () => {
  it('parses an approval request frame', () => {
    const parsed = parseComputerUseApprovalEvent({
      type: 'computer-use-approval-request',
      requestId: 'req-9',
      sessionId: 'session-1',
      tool: 'browser_type',
      op: 'type',
      summary: '在元素 e7 输入 12 个字符',
      risk: 'input',
      sensitive: null,
      rememberable: false,
      params: { elementId: 'e7', text: '<已脱敏 12 字>' },
    });
    expect(parsed).toEqual({
      kind: 'request',
      request: {
        request_id: 'req-9',
        session_id: 'session-1',
        tool: 'browser_type',
        op: 'type',
        summary: '在元素 e7 输入 12 个字符',
        risk: 'input',
        sensitive: null,
        rememberable: false,
        params: { elementId: 'e7', text: '<已脱敏 12 字>' },
      },
    });
  });

  it('parses the resolved frame', () => {
    expect(
      parseComputerUseApprovalEvent({
        type: 'computer-use-approval-resolved',
        requestId: 'req-9',
        decision: 'reject',
      }),
    ).toEqual({ kind: 'resolved', requestId: 'req-9' });
  });

  it('ignores unrelated and malformed frames', () => {
    expect(parseComputerUseApprovalEvent({ type: 'turn_finished' })).toBeNull();
    expect(parseComputerUseApprovalEvent({ type: 'computer-use-approval-request' })).toBeNull();
    expect(parseComputerUseApprovalEvent('not json')).toBeNull();
    expect(parseComputerUseApprovalEvent(null)).toBeNull();
  });

  it('accepts a raw JSON string frame', () => {
    const parsed = parseComputerUseApprovalEvent(
      JSON.stringify({
        type: 'computer-use-approval-request',
        requestId: 'req-1',
        risk: 'readOnly',
        rememberable: true,
      }),
    );
    expect(parsed?.kind).toBe('request');
    if (parsed?.kind === 'request') {
      expect(parsed.request.risk).toBe('readOnly');
      expect(parsed.request.rememberable).toBe(true);
    }
  });
});

describe('approval queue', () => {
  it('deduplicates replays of the same requestId', () => {
    const first = enqueueComputerUseApproval([], request());
    const second = enqueueComputerUseApproval(first, request());
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it('removes only the settled request', () => {
    const list = [request({ request_id: 'a' }), request({ request_id: 'b' })];
    expect(dequeueComputerUseApproval(list, 'a').map((item) => item.request_id)).toEqual(['b']);
    expect(dequeueComputerUseApproval(list, 'missing')).toBe(list);
  });
});

describe('granularity options', () => {
  it('offers session memory for read-only requests the daemon allows to remember', () => {
    const options = computerUseApprovalOptions(
      request({ op: 'snapshot', risk: 'readOnly', rememberable: true }),
    );
    expect(options.map((option) => option.choice)).toEqual(['once', 'always', 'reject']);
  });

  it('never offers session memory for input actions', () => {
    const options = computerUseApprovalOptions(request({ risk: 'input' }));
    expect(options.map((option) => option.choice)).toEqual(['once', 'reject']);
    expect(options[0].description).toContain('每次都询问');
  });

  it('never offers session memory for sensitive scenarios', () => {
    const options = computerUseApprovalOptions(
      request({ risk: 'input', sensitive: '支付', rememberable: false }),
    );
    expect(options.map((option) => option.choice)).toEqual(['once', 'reject']);
    expect(computerUseApprovalReason(request({ sensitive: '支付' }))).toContain('敏感场景（支付）');
  });

  it('falls back to per-step approval when the daemon marks a read-only op unrememberable', () => {
    const options = computerUseApprovalOptions(
      request({ op: 'screenshot', risk: 'readOnly', rememberable: false }),
    );
    expect(options.map((option) => option.choice)).toEqual(['once', 'reject']);
  });
});
