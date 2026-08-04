import type { SVGProps } from 'react';

interface RoundedPanelIconProps extends SVGProps<SVGSVGElement> {
  side: 'left' | 'right';
  expanded: boolean;
}

export function RoundedPanelIcon({ side, expanded, ...props }: RoundedPanelIconProps) {
  const dividerPath = expanded
    ? side === 'left' ? 'M9 5v14' : 'M17 5v14'
    : side === 'left' ? 'M8 8v8' : 'M18 8v8';

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="3" width="20" height="18" rx="4" />
      <path d={dividerPath} />
    </svg>
  )
}
