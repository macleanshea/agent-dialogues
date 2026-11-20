import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small (i) that reveals an explanation on hover or keyboard focus. Use it
 * for explainers, so the page itself stays short.
 */
export function Info({ children, className, label = "More information" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <span className={cn("group relative inline-flex align-middle", className)}>
      <span
        tabIndex={0}
        role="button"
        aria-label={label}
        className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-muted-foreground/50 font-serif text-[10px] leading-none font-semibold text-muted-foreground italic hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute top-full left-1/2 z-30 mt-1.5 w-72 -translate-x-1/2 rounded-md border border-border bg-card px-2.5 py-2 text-left text-xs leading-snug font-normal tracking-normal text-foreground normal-case shadow-md group-focus-within:visible group-hover:visible"
      >
        {children}
      </span>
    </span>
  );
}
