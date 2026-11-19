import { defaultRunConfig } from "@/lib/config";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";
// Runs execute inside the form submission in this version. 300 seconds is the
// Vercel Hobby limit.
export const maxDuration = 300;

export default function NewRunPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure two agents, A and B. They talk for a set number of turns, and that is repeated for each
          conversation.
        </p>
      </div>
      <RunForm initial={defaultRunConfig()} />
    </div>
  );
}
