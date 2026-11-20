import { defaultRunConfig } from "@/lib/config";
import { listFieldLibrary } from "@/lib/analysis/service";
import { getDb } from "@/lib/db";
import { toPickerField } from "@/lib/fields/picker";
import { RunForm } from "./run-form";

export const dynamic = "force-dynamic";
export default async function NewRunPage() {
  const fields = (await listFieldLibrary(await getDb())).map(toPickerField);
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
      <RunForm initial={defaultRunConfig()} fields={fields} />
    </div>
  );
}
