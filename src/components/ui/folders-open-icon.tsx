/**
 * 「打开的多文件夹」图标：Lucide 只有 Folders（闭合）和 FolderOpen（单层打开），
 * 没有叠加两者的现成图标。这里沿用 Folders 的背层轮廓，把前层换成 FolderOpen，
 * 让多根项目展开时既有打开状态、又保留多文件夹识别度。
 */
export function FoldersOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-icon="folders-open"
      aria-hidden="true"
    >
      {/* 背层：与 Lucide Folders 的第二条路径一致 */}
      <path d="M2 8v11a2 2 0 0 0 2 2h14" />
      {/* 前层：FolderOpen 缩小后放在 Folders 前层的位置；描边按缩放反向补偿 */}
      <g transform="translate(5 2) scale(0.78)">
        <path
          strokeWidth="2.56"
          d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
        />
      </g>
    </svg>
  );
}
