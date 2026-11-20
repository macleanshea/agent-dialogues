import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Info } from "./info";

const control =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(control, "min-h-24 font-mono text-[13px]", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(control, "pr-8", className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm font-medium", className)} {...props} />;
}

/** A labelled field. A hint is shown behind an (i) next to the label; an error is always shown. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <Info>{hint}</Info>}
      </div>
      {children}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A checkbox with a label to its right. */
export function Toggle({
  id,
  label,
  hint,
  error,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { id: string; label: ReactNode; hint?: ReactNode; error?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
        {...props}
      />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={id} className={cn(props.disabled && "text-muted-foreground")}>
            {label}
          </Label>
          {hint && <Info>{hint}</Info>}
        </div>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
