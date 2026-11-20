import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Info } from "@/components/ui/info";
import { PROMPT_CATALOG } from "@/lib/analysis/prompts";

export const metadata = { title: "Prompts · Agent Dialogues" };

/** Every analysis prompt, read-only, exactly as sent. They live in src/lib/analysis/prompts.ts. */
export default function PromptsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        Prompts
        <Info>
          The analysis prompts, read-only. Text in double braces, like {"{{transcript}}"}, is filled in for each call. Each analysis version
          records which prompt versions it used.
        </Info>
      </h1>
      {PROMPT_CATALOG.map((p) => (
        <Card key={p.key} data-testid="prompt">
          <CardHeader title={`${p.title} (${p.version})`} info={p.when} />
          <CardBody>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{p.text}</pre>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
