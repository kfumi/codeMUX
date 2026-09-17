"use client"

import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { ChevronRight } from "lucide-react"

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
        'z-50 min-w-32 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-[0_10px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_32px_-12px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 fill-mode-both',
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

const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border/70', className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuSub = ContextMenuPrimitive.Sub

const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      'outline-none flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-xs text-foreground/82 transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted',
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55" />
  </ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(
        'z-50 min-w-32 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-[0_10px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_32px_-12px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 fill-mode-both',
        className,
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
}
