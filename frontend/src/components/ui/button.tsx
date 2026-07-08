import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition duration-200 touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[pending=true]:cursor-wait data-[pending=true]:opacity-80",
  {
    variants: {
      variant: {
        default: "bg-white text-black shadow-[0_10px_28px_rgba(0,0,0,0.45)] hover:bg-zinc-200 hover:-translate-y-0.5",
        secondary: "bg-zinc-800 text-white hover:bg-zinc-700 hover:-translate-y-0.5",
        ghost: "text-zinc-400 hover:bg-zinc-900 hover:text-white",
        outline: "border border-zinc-800 bg-transparent text-zinc-100 hover:bg-zinc-900 hover:-translate-y-0.5",
        destructive: "bg-zinc-700 text-white hover:bg-zinc-600"
      },
      size: {
        default: "h-11 px-4",
        sm: "h-11 px-3",
        icon: "h-11 w-11 px-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

type ButtonClickHandler = (event: React.MouseEvent<HTMLButtonElement>) => unknown;

export type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    debounceMs?: number;
    loading?: boolean;
    loadingText?: string;
    onClick?: ButtonClickHandler;
  };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ children, className, debounceMs = 450, disabled, loading = false, loadingText, onClick, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const [pending, setPending] = React.useState(false);
    const lockUntilRef = React.useRef(0);
    const isBusy = loading || pending;

    function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
      if (!onClick) return;

      const now = Date.now();
      if (isBusy || now < lockUntilRef.current) {
        event.preventDefault();
        return;
      }

      lockUntilRef.current = now + debounceMs;

      try {
        const result = onClick(event);

        if (result && typeof (result as Promise<unknown>).then === "function") {
          setPending(true);
          void (result as Promise<unknown>)
            .catch((error) => {
              console.error("[ui:button] click action failed", error);
            })
            .finally(() => {
              setPending(false);
            });
        }
      } catch (error) {
        setPending(false);
        throw error;
      }
    }

    return (
      <Comp
        ref={ref}
        aria-busy={isBusy || undefined}
        className={cn(buttonVariants({ variant, size, className }))}
        data-pending={isBusy ? "true" : undefined}
        disabled={disabled || isBusy}
        onClick={handleClick}
        {...props}
      >
        {isBusy ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
        {isBusy && loadingText ? loadingText : children}
      </Comp>
    );
  }
);

Button.displayName = "Button";
