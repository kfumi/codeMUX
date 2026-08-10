import { FileIcon } from '@react-symbols/icons/utils';
import type { SVGProps } from 'react';

import { cn } from '@/lib/utils';

type FileTypeIconProps = SVGProps<SVGSVGElement> & {
  filePath: string;
};

function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

/**
 * VS Code Symbols-style icon resolver.
 * It recognizes language extensions and special names such as package.json,
 * Dockerfile, tsconfig.json, vite.config.ts, and pnpm-lock.yaml.
 */
export function FileTypeIcon({ filePath, className, ...props }: FileTypeIconProps) {
  return (
    <FileIcon
      fileName={getFileName(filePath)}
      autoAssign
      {...props}
      width={14}
      height={14}
      aria-hidden={props['aria-hidden'] ?? true}
      focusable="false"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
    />
  );
}
