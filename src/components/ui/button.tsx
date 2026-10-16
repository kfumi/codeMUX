import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[background-color,border-color,color,transform] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background text-foreground hover:bg-muted hover:text-foreground",
        // 软按钮 —— Codex 的 `color: secondary`：墨色 5% 填充、无描边，hover 加重到 10%。
        // 设置页里的行内动作（复制路径 / 打开目录 / 更改）就是这一档。
        secondary:
          "bg-[hsl(var(--foreground)/0.05)] text-foreground hover:bg-[hsl(var(--foreground)/0.1)]",
        ghost: "hover:bg-muted/62 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.78]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        // 设置页行内动作档 —— 28px 高（Codex 的 `settingsAction`）。
        xs: "h-7 gap-1.5 px-2.5 text-ui-compact",
        lg: "h-11 px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
