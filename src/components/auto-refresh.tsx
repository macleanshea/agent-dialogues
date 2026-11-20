"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page from the server every 2 seconds while `active`, so new
 * turns and costs appear without a reload. No token streaming: each refresh
 * shows whole turns as they are stored.
 */
export function AutoRefresh({ active, intervalMs = 2000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live">
      <span className="size-2 animate-pulse rounded-full bg-blue-500" aria-hidden />
      Live, updating every {Math.round(intervalMs / 1000)} seconds
    </span>
  );
}
