import { ReactNode } from 'react';
import { TitleBar } from './TitleBar';

interface MainLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
  preview?: ReactNode;
}

export function MainLayout({ sidebar, children, preview }: MainLayoutProps) {
  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Title bar — spans full width, window controls on far right */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — follows theme */}
        <aside className="w-[260px] flex flex-col bg-[hsl(var(--sidebar-bg))] border-r border-[hsl(var(--sidebar-border))] shrink-0 relative sidebar-grain rounded-tr-2xl rounded-br-2xl">
          <div className="relative z-10 flex flex-col h-full">
            {sidebar}
          </div>
        </aside>

        {/* Main content area */}
        <main className="flex-1 flex overflow-hidden bg-background">
          <div className="flex-1 flex flex-col min-w-0">
            {children}
          </div>
          {preview}
        </main>
      </div>
    </div>
  );
}
