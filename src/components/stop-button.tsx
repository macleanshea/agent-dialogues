"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";

export function StopButton({ onStop }: { onStop: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      className="border-destructive/40 text-destructive hover:bg-destructive/10"
      disabled={pending}
      onClick={() => startTransition(() => onStop())}
    >
      {pending ? "Stopping…" : "Stop run"}
    </Button>
  );
}
