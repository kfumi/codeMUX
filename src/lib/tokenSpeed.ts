const DENSE_CHARS_PER_TOKEN = 1.8;
const OTHER_CHARS_PER_TOKEN = 4;

export const TAU_MS = 1500;
export const WARMUP_MS = 300;
export const MAX_OUTPUT_SPEED = 999.9;

function isWhitespace(codePoint: number): boolean {
  return codePoint === 0x20
    || (codePoint >= 0x09 && codePoint <= 0x0d)
    || codePoint === 0xa0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200a)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff;
}

function isDenseCharacter(codePoint: number): boolean {
  if (codePoint < 0x1100) return false;
  if (codePoint <= 0x11ff) return true; // Hangul Jamo
  if (codePoint < 0x2e80) return false;
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x3130 && codePoint <= 0x318f)
    || (codePoint >= 0x31c0 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xa960 && codePoint <= 0xa97f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7ff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff01 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || codePoint > 0xffff
  );
}

/** Rough visible-output token count used only for the live relative speed gauge. */
export function estimateOutputTokens(text: string): number {
  let denseCharacters = 0;
  let otherCharacters = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isWhitespace(codePoint)) continue;
    if (isDenseCharacter(codePoint)) denseCharacters += 1;
    else otherCharacters += 1;
  }

  return denseCharacters / DENSE_CHARS_PER_TOKEN + otherCharacters / OTHER_CHARS_PER_TOKEN;
}

export class TokenSpeedTracker {
  private lastTime: number | null = null;
  private lastTokens = 0;
  private elapsed = 0;
  private ewma = 0;
  private weight = 0;

  reset(): void {
    this.lastTime = null;
    this.lastTokens = 0;
    this.elapsed = 0;
    this.ewma = 0;
    this.weight = 0;
  }

  /** Feed a cumulative token count at `nowMs`; return a smoothed tok/s reading. */
  update(cumulativeTokens: number, nowMs: number): number | null {
    const totalTokens = Number.isFinite(cumulativeTokens)
      ? Math.max(0, cumulativeTokens)
      : 0;

    if (this.lastTime === null) {
      this.lastTime = nowMs;
      this.lastTokens = totalTokens;
      return null;
    }

    const dt = nowMs - this.lastTime;
    if (dt <= 0) return this.read();

    const instantaneous = Math.max(0, totalTokens - this.lastTokens) * 1000 / dt;
    this.lastTime = nowMs;
    this.lastTokens = totalTokens;
    this.elapsed += dt;

    const alpha = 1 - Math.exp(-dt / TAU_MS);
    this.ewma = this.ewma * (1 - alpha) + instantaneous * alpha;
    this.weight = this.weight * (1 - alpha) + alpha;
    return this.read();
  }

  private read(): number | null {
    if (this.elapsed < WARMUP_MS || this.weight <= 0) return null;
    return Math.min(MAX_OUTPUT_SPEED, Math.max(0, this.ewma / this.weight));
  }
}
