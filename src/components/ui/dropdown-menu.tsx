"use client"

import * as React from "react"
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu"

import { cn } from "@/lib/utils"

const DropdownMenu = DropdownMenuPrimitive.Root

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'surface-panel z-160 min-w-40 rounded-md border border-border/70 bg-popover/98 p-1.5 shadow-[0_16px_42px_-28px_hsl(var(--foreground)/0.34),0_0_0_1px_hsl(var(--background)/0.68)] backdrop-blur-md animate-in fade-in blur-in-4 fill-mode-both animation-duration-[160ms] [animation-timing-function:cubic-bezier(0.16,1,0.3,1)] dark:bg-[linear-gradient(180deg,hsl(var(--surface-2))/0.96,hsl(var(--surface-1))/0.94)] dark:shadow-[0_22px_56px_-34px_hsl(var(--surface-shadow-strong)/0.9),0_0_0_1px_hsl(var(--foreground)/0.034)]',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
))
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName

interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  danger?: boolean
  icon?: React.ReactNode
}

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(({ className, children, danger, icon, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'outline-none flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-foreground/82 transition-all duration-150 hover:bg-muted/62 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.78]',
      danger && 'text-destructive hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive',
      className,
    )}
    {...props}
  >
    {icon}
    {children}
  </DropdownMenuPrimitive.Item>
))
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem }
