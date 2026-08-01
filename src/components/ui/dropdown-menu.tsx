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
        'surface-panel z-160 min-w-40 rounded-md border bg-popover p-1 shadow-[0_14px_36px_-24px_hsl(var(--surface-shadow-strong)/0.45)] animate-in fade-in fill-mode-both animation-duration-[160ms] [animation-timing-function:ease-out]',
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
      'outline-none flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-foreground/82 transition-colors duration-150 hover:bg-muted hover:text-foreground',
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
