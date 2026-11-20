"use client";

import { useRef, type ReactNode } from "react";
import { Button } from "./button";

/** A button that opens a modal dialog. */
export function DialogButton({
  label,
  title,
  children,
  variant = "secondary",
  className,
  testId,
}: {
  label: ReactNode;
  title: ReactNode;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <Button type="button" variant={variant} className={className} onClick={() => ref.current?.showModal()}>
        {label}
      </Button>
      <dialog
        ref={ref}
        data-testid={testId}
        className="m-auto w-[min(42rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
        onClick={(e) => {
          // Clicking the backdrop closes it.
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 20 20" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </dialog>
    </>
  );
}
