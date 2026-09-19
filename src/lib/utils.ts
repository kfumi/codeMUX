import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * codeMUX 的字号档位是自定义 token（`text-ui-*`、`text-code`，见 globals.css 的 @theme）。
 * tailwind-merge 默认只认识 Tailwind 内置的 `text-*` 字号，认不出的 `text-ui-body`
 * 会被归进「文字颜色」组——于是同一串 class 里只要再出现 `text-muted-foreground`
 * 之类的颜色，字号就被静默丢掉（`text-ui-compact text-muted-foreground` → 只剩颜色，
 * 文本回落到继承的字号）。把这些 token 显式登记成 font-size，颜色组才不会再吃掉字号。
 */
const UI_TEXT_SIZE_TOKENS = [
  "ui-micro",
  "ui-caption",
  "ui-meta",
  "ui-compact",
  "ui-body",
  "ui-title",
  "ui-heading-sm",
  "ui-heading-md",
  "ui-heading-lg",
  "code",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: UI_TEXT_SIZE_TOKENS }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
