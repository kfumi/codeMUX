import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.04),0_12px_24px_-16px_hsl(var(--primary)/0.58)] hover:bg-primary/94 hover:shadow-[0_16px_34px_-20px_hsl(var(--primary)/0.56)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_8px_20px_-15px_hsl(var(--destructive)/0.42)] hover:bg-destructive/90",
        outline:
          "border border-input bg-background/92 text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.018)] hover:bg-muted/72 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.86]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/78 dark:hover:bg-[hsl(var(--surface-3))/0.78]",
        ghost: "hover:bg-muted/62 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.78]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-lg px-3",
        lg: "h-11 rounded-lg px-8",
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
