import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-sm text-muted-foreground">That experiment, run, or conversation does not exist.</p>
      <ButtonLink href="/" variant="secondary">
        Back to experiments
      </ButtonLink>
    </div>
  );
}
