/**
 * 手动贴屏(工单 04):把壳回传的 base64 PNG 变成可贴进会话的图片附件。
 *
 * 与「智能体让会话截图」是两条路:这条是用户自己点一下,只读、不经 daemon
 * 闸门、也不进审计 —— 用户给自己的东西不需要审批。
 */

/** base64 PNG → File(附件管线按文件名判类型,所以名字必须带 .png)。 */
export function base64PngToFile(base64: string, fileName: string): File {
  const clean = base64.replace(/^data:image\/png;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: 'image/png' });
}

/** 贴屏附件文件名:带时间戳,同一会话里两张截图不互相覆盖。 */
export function screenshotFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `桌面截图-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
