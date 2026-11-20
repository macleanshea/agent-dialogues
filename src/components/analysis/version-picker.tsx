import Link from "next/link";
import { cn } from "@/lib/utils";

/** Links to each analysis version. Earlier versions stay selectable after re-analysis. */
export function VersionPicker({ base, versions, current }: { base: string; versions: number[]; current: number }) {
  if (versions.length <= 1) return <span className="text-xs text-muted-foreground">Analysis v{current}</span>;
  return (
    <nav aria-label="Analysis version" className="flex flex-wrap items-center gap-1 text-xs" data-testid="version-picker">
      <span className="mr-1 text-muted-foreground">Analysis version:</span>
      {versions.map((v) => (
        <Link
          key={v}
          href={`${base}?v=${v}`}
          aria-current={v === current ? "page" : undefined}
          className={cn(
            "rounded-md border px-2 py-0.5 font-mono",
            v === current ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted",
          )}
        >
          v{v}
        </Link>
      ))}
    </nav>
  );
}

/** Reads ?v=2 from the page's search params. */
export function versionParam(sp: Record<string, string | string[] | undefined>): number | null {
  const raw = Array.isArray(sp.v) ? sp.v[0] : sp.v;
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}
