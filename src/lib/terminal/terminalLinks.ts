import type { IBuffer, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/**
 * 终端里的 http(s) 链接识别。
 *
 * 与 xterm 的 OSC 8 超链接是两条独立通路：
 * - OSC 8（`linkHandler`）由程序显式声明；
 * - 这里是**纯文本**识别，覆盖 `vite` / `npm` / `curl` 这类只打印 URL 的输出。
 *
 * 两个容易踩的点：
 * 1. URL 会被终端折行。只看当前 buffer line 会得到半截链接，所以要沿 `isWrapped`
 *    向上回溯到逻辑行起点，再把整行拼起来匹配。
 * 2. 句子里的 URL 常带尾部标点（`https://x.dev/a).`），要按「不成对的右括号」规则裁掉。
 */

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);

const CLOSING_BRACKETS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

/** 去掉 URL 尾部的句读与不成对的右括号，返回真正可点击的部分。 */
export function trimTerminalUrl(value: string): string {
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];

    if (TRAILING_PUNCTUATION.has(char)) {
      end -= 1;
      continue;
    }

    const opening = CLOSING_BRACKETS[char];
    if (opening) {
      const candidate = value.slice(0, end);
      const opens = candidate.split(opening).length - 1;
      const closes = candidate.split(char).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return value.slice(0, end);
}

export interface TerminalTextLink {
  text: string;
  /** 在 `text` 里的起始字符下标。 */
  start: number;
  /** 在 `text` 里的结束字符下标（含）。 */
  end: number;
}

export function findTerminalTextLinks(text: string): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const raw = match[0];
    const value = trimTerminalUrl(raw);
    // 至少要有 host：`https://` 本身不算链接。
    if (!/^https?:\/\/[^/]/i.test(value)) continue;

    const start = match.index ?? 0;
    links.push({ text: value, start, end: start + value.length - 1 });
  }

  return links;
}

interface CellPosition {
  x: number;
  y: number;
}

interface LineSnapshot {
  text: string;
  cells: CellPosition[];
}

/**
 * 把从 `startY` 开始的逻辑行拍平成文本，并记录每个字符对应的 cell 坐标。
 * 宽字符的第二个 cell（width 0）跳过；空 cell 记作空格。
 */
export function snapshotLogicalLine(buffer: IBuffer, startY: number): LineSnapshot {
  let text = '';
  const cells: CellPosition[] = [];
  let y = startY;

  while (true) {
    const line = buffer.getLine(y);
    if (!line) break;

    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;

      const chars = cell.getChars();
      text += chars.length > 0 ? chars : ' ';
      cells.push({ x, y });
    }

    // `isWrapped` 标在**续行**上：下一行是续行才说明本行还没结束。
    if (!buffer.getLine(y + 1)?.isWrapped) break;
    y += 1;
  }

  return { text, cells };
}

/** 从请求行向上找到逻辑行起点（xterm 的 `bufferLineNumber` 是 1-based）。 */
export function logicalLineStart(buffer: IBuffer, bufferLineNumber: number): number {
  let startY = bufferLineNumber - 1;
  while (startY > 0 && buffer.getLine(startY)?.isWrapped) {
    startY -= 1;
  }
  return startY;
}

export function createTerminalLinkProvider(
  term: Terminal,
  activate: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const startY = logicalLineStart(buffer, bufferLineNumber);
      const snapshot = snapshotLogicalLine(buffer, startY);
      const links: ILink[] = [];

      for (const textLink of findTerminalTextLinks(snapshot.text)) {
        const startCell = snapshot.cells[textLink.start];
        const endCell = snapshot.cells[textLink.start + textLink.text.length - 1];
        if (!startCell || !endCell) continue;

        // xterm 的 range 是 1-based；这条 provider 只回答被问到的那个 buffer 行。
        const range = {
          start: { x: startCell.x + 1, y: startCell.y + 1 },
          end: { x: endCell.x + 1, y: endCell.y + 1 },
        };
        if (range.start.y > bufferLineNumber || range.end.y < bufferLineNumber) continue;

        links.push({
          text: textLink.text,
          range,
          decorations: { underline: true, pointerCursor: true },
          activate: () => activate(textLink.text),
        });
      }

      callback(links);
    },
  };
}
