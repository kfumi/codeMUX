/**
 * shell 合成键鼠输入的预检（工单 13）。
 *
 * 存在的原因（实测）：桌面输入面缺失时，模型会自己用 `powershell -c` 拼
 * P/Invoke 调 `mouse_event` 去点桌面 —— 那条路绕过电脑控制的审批闸门，
 * 审计里一行都没有。补齐输入工具面之后，诚实路径好走了，但绕过路径还在，
 * 所以这里再补一道：**命中就用拒绝把模型指回 computer_* 工具**。
 *
 * 怎么减少误伤：只看「命令行片段以解释器/编译起手」的片段（`grep mouse_event`
 * 不算），再在该片段里找输入合成特征。仍然会误伤 `python -c "print('mouse_event')"`
 * 这种，但宁可让它改成写文件再跑，也不要让「用 shell 点到你的银行页面」静默通过。
 *
 * 边界（如实记录）：
 * - 拦不到**脚本文件与已编译二进制里的**键鼠调用（`cscript click.vbs`、
 *   `.\clicker.exe`）——文本预检看不见文件内容；
 * - `-EncodedCommand` 之类被拦是因为它**看不清**，不是因为解析出了键鼠；
 * - 真正的深层绕过（自写驱动、直接 syscall）拦不住。
 *
 * 这道闸门管的是「明显的、当场看得见的那一类」，剩下那几类靠的是：输入面
 * 本身好用（模型没有动机去绕）、技能里的纪律、以及审计留下的痕迹。
 */

/** 命中结果：`code` 说明拦的理由，`signal` 是命中的特征（写进拒绝文案便于解释）。 */
export interface ShellInputSynthesisHit {
  code: 'input-synthesis' | 'encoded-command';
  signal: string;
}

/**
 * 解释器/编译起手词：只有命令片段从这些词开始，才认为「要执行点什么」。
 *
 * 含 `Add-Type`（PowerShell 内联编译 C# 的标准入口）与 `csc`（直接编译）。
 * 不含 `echo`/`grep`/`rg`/`git` —— 那些只是提到字符串，不是执行。
 */
const EXECUTION_HOSTS = [
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'wscript',
  'wscript.exe',
  'cscript',
  'cscript.exe',
  'mshta',
  'mshta.exe',
  'rundll32',
  'rundll32.exe',
  'regsvr32',
  'regsvr32.exe',
  'csc',
  'csc.exe',
  'add-type',
  'python',
  'python3',
  'py',
  'node',
  'node.exe',
  'perl',
  'ruby',
  'php',
  'osascript',
  'nircmd',
  'nircmd.exe',
  'autohotkey',
  'autohotkey.exe',
  'ahk',
  'robotjs',
  'xdotool',
];

/** 输入合成特征（大小写不敏感子串）：键鼠事件的常见写法。 */
const INPUT_SYNTHESIS_TOKENS = [
  'mouse_event',
  'sendinput',
  'keybd_event',
  'setcursorpos',
  'getasynckeystate',
  'sendkeys',
  'dllimport',
  'user32.dll',
  'iuiautomation',
  'uiautomationclient',
  'wm_lbuttondown',
  'wm_keydown',
  'robotjs',
  'xdotool',
  'nircmd',
  // .NET 侧移动真实光标（点击配方的一半）:
  'windows.forms.cursor',
];

/** 看不到内容的命令：base64 编码与「下载即执行」。 */
const OPAQUE_TOKENS = ['-encodedcommand', '-enc ', 'frombase64string'];

/**
 * 按引号外的分隔符切片段：`;`、`&&`、`||`、`|`、换行。
 *
 * 必须做引号感知：`pwsh -Command "Add-Type ...; [SendKeys]::SendWait(...)"` 里的
 * `;` 是脚本内部的分号，按它切会把真正的载荷切到另一个片段里，于是漏判
 * （这不是假想 —— 第一版就是这么漏的，被测试抓住）。
 */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    // PowerShell 的反引号转义与别处的反斜杠转义：跳过被转义的引号。
    if (quote && (char === '`' || char === '\\') && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        // 成对引号是转义（SQL/PS 风格），连着的下一个不算闭合。
        if (command[index + 1] === quote) {
          current += char + char;
          index += 1;
          continue;
        }
        quote = null;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (char === '\n' || char === ';' || pair === '&&' || pair === '||' || char === '|' || char === '&') {
      segments.push(current);
      current = '';
      if (pair === '&&' || pair === '||') index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** 片段是否从某个执行起手词开始（允许 `sudo`/`Start-Process` 之类的前缀）。 */
function executionHost(segment: string): string | null {
  const words = segment
    .toLowerCase()
    .replace(/^["'`]+/, '')
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words.slice(0, 3)) {
    const bare = word.replace(/\.exe$/, '');
    const host = EXECUTION_HOSTS.find(
      (candidate) => candidate === word || candidate.replace(/\.exe$/, '') === bare,
    );
    if (host) return host;
  }
  return null;
}

/**
 * 预检一条 shell 命令：命中返回拦下的理由，放行返回 `null`。
 *
 * 纯函数（无 IO），便于逐例测试 —— 这条闸门的误伤代价由测试表钉住。
 */
export function detectShellInputSynthesis(command: string): ShellInputSynthesisHit | null {
  const text = command.trim();
  if (!text) return null;
  for (const segment of commandSegments(text)) {
    const host = executionHost(segment);
    if (!host) continue;
    const lowered = segment.toLowerCase();
    const opaque = OPAQUE_TOKENS.find((token) => lowered.includes(token));
    if (opaque) {
      return { code: 'encoded-command', signal: opaque.trim() };
    }
    const token = INPUT_SYNTHESIS_TOKENS.find((candidate) => lowered.includes(candidate));
    if (token) {
      return { code: 'input-synthesis', signal: token };
    }
  }
  return null;
}

/**
 * 拒绝文案（面向模型）：说清为什么拦、改用什么、以及人怎么放行。
 *
 * 不写「请用户确认后重试」这种空话 —— 模型拿不到一条可执行的下一步就只会
 * 换个写法再试一次。
 */
export function shellInputSynthesisMessage(hit: ShellInputSynthesisHit): string {
  if (hit.code === 'encoded-command') {
    return `这条 shell 命令是编码/不透明的（命中 ${hit.signal}），在你动手之前无法看清它做什么，已拒绝。请把命令写成明文再试；如果它确实要合成键鼠输入，改用桌面工具（computer_elements 取目标 → computer_click / computer_type / computer_key）。`;
  }
  return `这条 shell 命令会自己合成键鼠输入（命中 ${hit.signal}），绕过电脑控制的审批与审计，已拒绝。桌面操作请改用 computer_* 工具：先用 computer_elements / computer_windows 取目标，再用 computer_click / computer_type / computer_key / computer_launch 动作（可后台投递、不抢焦点，每一步都有审批与审计）。若确实需要在 shell 里跑这类代码，请让用户自己在终端执行。`;
}
