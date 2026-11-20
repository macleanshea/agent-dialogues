import { defaultRunConfig } from "@/lib/config";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";
// Runs execute inside the form submission in this version. 300 seconds is the
// Vercel Hobby limit.
export const maxDuration = 300;

export default function NewRunPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
      <RunForm initial={defaultRunConfig()} />
    </div>
  );
}
