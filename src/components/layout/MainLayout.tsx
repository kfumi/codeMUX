import { ReactNode } from 'react';

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  return (
    <div className="flex h-screen bg-background">
      <aside className="w-64 border-r bg-muted/30 flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col">
          {children}
        </div>
        {preview}
      </main>
    </div>
  );
}
