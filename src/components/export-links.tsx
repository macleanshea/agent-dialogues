import { exportHref } from "@/lib/ids";
import { cn } from "@/lib/utils";

const link =
  "inline-flex items-center justify-center rounded-md border border-border bg-background px-3.5 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * "Export JSON" and "Export Markdown" downloads for an experiment or a run.
 * Plain links (not client-side navigation), since they download a file.
 */
export function ExportLinks({ exp, run, version, className }: { exp: number; run?: number; version?: number; className?: string }) {
  return (
    <span className={cn("inline-flex gap-2", className)} data-testid="export-links">
      <a className={link} href={exportHref("json", exp, run)} download>
        Export JSON
      </a>
      <a className={link} href={exportHref("md", exp, run, version)} download>
        Export Markdown
      </a>
    </span>
  );
}
