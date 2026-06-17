import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.03),0_10px_26px_-16px_hsl(var(--primary)/0.58)] hover:bg-primary/92 hover:shadow-[0_14px_34px_-18px_hsl(var(--primary)/0.68)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_8px_24px_-14px_hsl(var(--destructive)/0.55)] hover:bg-destructive/90",
        outline:
          "border border-input bg-background/90 text-foreground shadow-[0_1px_0_0_hsl(var(--foreground)/0.02)] hover:bg-muted/75 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.9]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/82 dark:hover:bg-[hsl(var(--surface-3))/0.88]",
        ghost: "hover:bg-muted/72 hover:text-foreground dark:hover:bg-[hsl(var(--surface-3))/0.88]",
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
