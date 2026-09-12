export function GitForkIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" 
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
         className={className}>
      <path d="M16 3h5v5M8 3H3v5"/>
      <path d="m21 3l-7.536 7.536A5 5 0 0 0 12 14.07V21M3 3l7.536 7.536A5 5 0 0 1 12 14.07V15"/>
    </svg>
  )
}
