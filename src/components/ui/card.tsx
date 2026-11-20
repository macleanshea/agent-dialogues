import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Info } from "./info";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

/**
 * A card's title row. `description` is for short facts (a count, a model);
 * explanations go in `info`, shown on hover.
 */
export function CardHeader({ title, description, info, actions }: { title: ReactNode; description?: ReactNode; info?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {title}
          {info && <Info>{info}</Info>}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}
