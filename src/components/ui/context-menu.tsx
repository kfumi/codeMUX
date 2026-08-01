"use client"

import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"

import { cn } from "@/lib/utils"

const ContextMenu = ContextMenuPrimitive.Root

const ContextMenuTrigger = ContextMenuPrimitive.Trigger

const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 min-w-32 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-[0_14px_36px_-24px_hsl(var(--surface-shadow-strong)/0.45)] animate-in fade-in zoom-in-95 fill-mode-both',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

interface ContextMenuItemProps extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> {
  danger?: boolean
  icon?: React.ReactNode
}

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  ContextMenuItemProps
>(({ className, children, danger, icon, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'outline-none flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs text-foreground/82 transition-colors hover:bg-muted hover:text-foreground',
      danger && 'text-destructive hover:bg-[hsl(var(--destructive)/0.1)] hover:text-destructive',
      className,
    )}
    {...props}
  >
    {icon}
    {children}
  </ContextMenuPrimitive.Item>
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

export { ContextMenu, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem }
