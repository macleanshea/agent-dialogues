"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Info } from "./info";

/**
 * A card that collapses to its title row. Collapsed by default unless `open`.
 * It opens itself when the URL's #hash names it, so links like
 * /runs/2#report land on an open section.
 */
export function Section({
  id,
  title,
  meta,
  info,
  actions,
  open = false,
  children,
  className,
  testId,
}: {
  id: string;
  title: ReactNode;
  /** Short facts shown next to the title, visible while collapsed (a status, a count). */
  meta?: ReactNode;
  info?: ReactNode;
  actions?: ReactNode;
  open?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const sync = () => {
      if (ref.current && window.location.hash === `#${id}`) ref.current.open = true;
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [id]);

  return (
    <details ref={ref} id={id} open={open} className={cn("group/section rounded-lg border border-border bg-card", className)} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 select-none [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 20 20"
          aria-hidden
          className="size-5 shrink-0 text-muted-foreground transition-transform group-open/section:rotate-90"
          fill="currentColor"
        >
          <path d="M7 4.5v11l8-5.5z" />
        </svg>
        <h2 className="text-base font-semibold">{title}</h2>
        {info && <Info>{info}</Info>}
        {meta && <span className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground">{meta}</span>}
        {actions && (
          <span className="ml-auto flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}
