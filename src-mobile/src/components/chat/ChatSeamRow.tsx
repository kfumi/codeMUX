interface ChatSeamRowProps {
  children: string;
}

export function ChatSeamRow({ children }: ChatSeamRowProps) {
  return (
    <div className="py-3 text-center">
      <span className="text-xs font-medium tracking-normal text-muted-foreground">
        {children}
      </span>
    </div>
  );
}
