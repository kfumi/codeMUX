// pi 临时扩展：审批（tool_call 拦截 + ctx.ui.select）与 ask-user（自定义工具）。
//
// pi 无原生审批 RPC；0.73.1 扩展 API 提供 `pi.on("tool_call")`（可 block）与
// `pi.registerTool`，等待用户时 `ctx.ui.select/input` 在 RPC 模式下自动序列化
// 为 `extension_ui_request`（title 里带 CodeMUX marker 供 sidecar 识别语义），
// sidecar 以 `extension_ui_response {value|cancelled}` 回包。扩展文件按会话
// 生成到临时目录，经 `--extension <path>` 注入，会话关闭即删除（对齐 paseo
// 的「运行时生成临时扩展」先例）。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** pi 审批档位：映射 CodeMUX execution mode（plan 档对 pi 不适用）。 */
export type PiApprovalMode = 'confirm_before_edit' | 'auto_edit' | 'full_access';

/** extension_ui_request.title 的 CodeMUX marker 前缀（RPC 模式下 title 只到客户端）。 */
export const PI_APPROVE_TITLE_PREFIX = '__codemux_approve__:';
export const PI_ASK_TITLE_PREFIX = '__codemux_ask__:';

/** 审批 select 的三个固定选项（顺序即语义，sidecar 按下标映射 once/always/reject）。 */
export const PI_APPROVAL_CHOICES = ['Allow', 'Always allow', 'Reject'] as const;

/**
 * 档位 → 需要审批的工具集合。confirm_before_edit 覆盖改动类工具；
 * auto_edit 只卡 bash；full_access 全放行。未列出的工具（read 等
 * 只读类与扩展自定义工具）直接放行。
 */
export function piApprovalTools(mode: PiApprovalMode): string[] {
  switch (mode) {
    case 'auto_edit':
      return ['bash'];
    case 'full_access':
      return [];
    case 'confirm_before_edit':
    default:
      return ['bash', 'edit', 'write'];
  }
}

export interface PiExtensionFile {
  path: string;
  cleanup: () => void;
}

/**
 * 生成临时扩展源码。策略以常量烧进源码（mode 变更走 pi 进程重建，
 * 与模型/思考等级的 canReuse 重建语义一致）。
 */
export function buildPiExtensionSource(mode: PiApprovalMode): string {
  // 生成物内避免模板字符串与反引号，防止转义层叠。
  return [
    'import { Type } from "typebox";',
    '',
    'const APPROVE_PREFIX = ' + JSON.stringify(PI_APPROVE_TITLE_PREFIX) + ';',
    'const ASK_PREFIX = ' + JSON.stringify(PI_ASK_TITLE_PREFIX) + ';',
    'const APPROVAL_TOOLS = new Set(' + JSON.stringify(piApprovalTools(mode)) + ');',
    '',
    'export default function codemuxIntegration(pi) {',
    '  const alwaysAllowed = new Set();',
    '',
    '  pi.on("tool_call", async (event, ctx) => {',
    '    const toolName = String(event.toolName ?? "");',
    '    if (!APPROVAL_TOOLS.has(toolName) || alwaysAllowed.has(toolName)) return undefined;',
    '    const title = APPROVE_PREFIX + JSON.stringify({ toolCallId: event.toolCallId, toolName });',
    '    const choice = await ctx.ui.select(title, ' + JSON.stringify(PI_APPROVAL_CHOICES) + ', { signal: ctx.signal });',
    '    if (choice === ' + JSON.stringify(PI_APPROVAL_CHOICES[1]) + ') {',
    '      alwaysAllowed.add(toolName);',
    '      return undefined;',
    '    }',
    '    if (choice === ' + JSON.stringify(PI_APPROVAL_CHOICES[2]) + ' || choice === undefined) {',
    '      return { block: true, reason: "CodeMUX: user rejected this tool call" };',
    '    }',
    '    return undefined;',
    '  });',
    '',
    '  pi.registerTool({',
    '    name: "ask_user_question",',
    '    label: "Ask User",',
    '    description: "Ask the user structured questions and wait for their answers."',
    '      + " Use this when you need a decision, a choice among options, or missing information."',
    '      + " Each question either carries options (single select) or expects free text.",',
    '    parameters: Type.Object({',
    '      questions: Type.Array(Type.Object({',
    '        question: Type.String({ description: "The question text shown to the user" }),',
    '        options: Type.Optional(Type.Array(Type.Object({',
    '          label: Type.String({ description: "Option label" }),',
    '          description: Type.Optional(Type.String({ description: "Option explanation" }))',
    '        }), { description: "Choices; omit for a free-text answer" })),',
    '      })),',
    '    }),',
    '    async execute(toolCallId, params, signal, _onUpdate, ctx) {',
    '      const questions = Array.isArray(params.questions) ? params.questions : [];',
    '      const answers = [];',
    '      for (let index = 0; index < questions.length; index += 1) {',
    '        if (signal?.aborted) break;',
    '        const question = questions[index] ?? {};',
    '        const title = ASK_PREFIX + JSON.stringify({ toolCallId, index });',
    '        const labels = Array.isArray(question.options)',
    '          ? question.options.map((option) => String(option?.label ?? "")).filter(Boolean)',
    '          : [];',
    '        let answer;',
    '        if (labels.length > 0) {',
    '          answer = await ctx.ui.select(title, labels, { signal });',
    '        } else {',
    '          answer = await ctx.ui.input(title, "", { signal });',
    '        }',
    '        answers.push({',
    '          question: String(question.question ?? ""),',
    '          answer: typeof answer === "string" ? answer : null,',
    '        });',
    '      }',
    '      const text = answers',
    '        .map((entry) => entry.question + ": " + (entry.answer ?? "(no answer)"))',
    '        .join("\\n");',
    '      return { content: [{ type: "text", text }], details: { answers } };',
    '    },',
    '  });',
    '}',
    '',
  ].join('\n');
}

/**
 * 写出临时扩展文件（os 临时目录下每会话独立目录）。cleanup 删除整个目录；
 * 调用方需在进程退出/会话关闭两条路径上都触发。
 */
export function createPiExtensionFile(mode: PiApprovalMode): PiExtensionFile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemux-pi-extension-'));
  const filePath = path.join(dir, 'codemux-integration.mjs');
  fs.writeFileSync(filePath, buildPiExtensionSource(mode), 'utf8');
  return {
    path: filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 解析 marker title 的 JSON payload（title = prefix + JSON.stringify(payload)）。
 * 形状不对返回 null（宁漏勿错：不认识的请求由调用方取消）。
 */
export function parsePiInteractiveTitle(
  prefix: string,
  title: string,
): Record<string, unknown> | null {
  if (!title.startsWith(prefix)) return null;
  try {
    const parsed: unknown = JSON.parse(title.slice(prefix.length));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
