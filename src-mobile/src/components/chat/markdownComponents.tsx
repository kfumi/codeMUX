import type { AnchorHTMLAttributes, HTMLAttributes, TableHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

export const MOBILE_MARKDOWN_COMPONENTS = {
  h1: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className={cn('mt-5 mb-2 scroll-m-20 text-xl font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className={cn('mt-5 mb-2 scroll-m-20 text-lg font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className={cn('mt-4 mb-1.5 scroll-m-20 text-base font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h4: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className={cn('mt-3.5 mb-1 scroll-m-20 text-base font-medium first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h5: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h5
      className={cn('mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  h6: ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h6
      className={cn('mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0', className)}
      {...props}
    />
  ),
  a: ({ className, href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn('text-[hsl(var(--codemux-link))] no-underline hover:opacity-80', className)}
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-4 overflow-x-auto rounded-md">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  ),
};
