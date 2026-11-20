import Link from "next/link";
import { StatusBadge } from "@/components/status";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { experimentId, runHref } from "@/lib/ids";
import { listExperiments } from "@/lib/runs/service";
import { formatDateTime, formatUsd } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const rows = await listExperiments(await getDb());

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">No experiments yet.</p>
          <ButtonLink href="/runs/new">Start your first run</ButtonLink>
        </Card>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>ID</Th>
                <Th>Name</Th>
                <Th>Variable</Th>
                <Th className="text-right">Runs</Th>
                <Th>Status</Th>
                <Th className="text-right">Total cost</Th>
                <Th>Last updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // A single-run experiment has no expander: the row opens its run page.
                const href = r.firstRunNumber ? runHref(r.number, r.firstRunNumber) : undefined;
                return (
                  <Tr key={r.number} data-testid="experiment-row">
                    <Td className="font-mono text-xs whitespace-nowrap">
                      {href ? <Link href={href}>{experimentId(r.number)}</Link> : experimentId(r.number)}
                    </Td>
                    <Td className="font-medium">
                      {href ? (
                        <Link href={href} className="hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                    </Td>
                    <Td className="text-muted-foreground">
                      {r.declaredVariables.length ? r.declaredVariables.join(", ") : "—"}
                    </Td>
                    <Td className="text-right tabular-nums">{r.runCount}</Td>
                    <Td>
                      <StatusBadge status={r.status} />
                    </Td>
                    <Td className="text-right tabular-nums">{formatUsd(r.totalCostUsd)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.updatedAt)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
