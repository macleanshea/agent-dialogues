import { Markdown } from "@/components/markdown";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { linkTurnRefs } from "@/lib/analysis/citations";
import { FIELD_TYPES, formatValue, slotsFor, type FieldDef, type FieldEntry } from "@/lib/analysis/fields";
import type { codings } from "@/lib/db/schema";
import { modelLabel } from "@/lib/models";
import { formatUsd } from "@/lib/utils";

type Coding = typeof codings.$inferSelect;

function TurnLinks({ turns }: { turns: string[] }) {
  if (!turns.length) return null;
  return (
    <span className="font-mono text-xs">
      {turns.map((t, i) => (
        <span key={t}>
          {i > 0 && ", "}
          <a className="underline" href={`#${t.split("-")[0]}`}>
            {t}
          </a>
        </span>
      ))}
    </span>
  );
}

function Entry({ def, label, e }: { def: FieldDef; label?: string; e: FieldEntry | undefined }) {
  if (!e) return <div className="text-xs text-muted-foreground">{label ? `${label}: ` : ""}not coded</div>;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-sm">
        {label && <span className="mr-1 font-semibold">{label}:</span>}
        <span data-testid={`value-${def.name}${label ? `-${label}` : ""}`}>{formatValue(def, e.value)}</span>
        {e.firstTurn !== null && <span className="ml-2 text-xs text-muted-foreground">first at T{e.firstTurn}</span>}
        {e.changeTurn !== null && <span className="ml-2 text-xs text-muted-foreground">changes at T{e.changeTurn}</span>}
      </div>
      {e.reason && (
        <div className="text-xs text-muted-foreground">
          {e.reason} <TurnLinks turns={e.turns} />
        </div>
      )}
    </div>
  );
}

/** One conversation's coding: summary, focus findings, notable, and every field with its reason and citations. */
export function CodingView({ coding, defs, custom }: { coding: Coding | null; defs: FieldDef[]; custom: Set<string> }) {
  if (!coding) {
    return (
      <Card data-testid="coding">
        <CardHeader title="Coding" />
        <CardBody>
          <p className="text-sm text-muted-foreground">Not coded under this analysis version.</p>
        </CardBody>
      </Card>
    );
  }
  const out = coding.output;
  return (
    <Card data-testid="coding">
      <CardHeader
        title="Coding"
        description={`${modelLabel(coding.model)} · ${formatUsd(coding.costUsd)}`}
        actions={<StatusBadge status={coding.status} />}
      />
      <CardBody className="flex flex-col gap-5">
        {coding.error && (
          <p className="text-sm text-destructive" role="alert">
            {coding.error}
          </p>
        )}
        {!out && !coding.error && <p className="text-sm text-muted-foreground">Coding in progress…</p>}
        {out && (
          <>
            <section>
              <h3 className="mb-1 text-sm font-semibold">Summary</h3>
              <Markdown>{linkTurnRefs(out.summary)}</Markdown>
            </section>
            <section>
              <h3 className="mb-1 text-sm font-semibold">Findings on the analysis focus</h3>
              {out.focusFindings.length ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                  {out.focusFindings.map((f, i) => (
                    <li key={i}>
                      {f.finding} <TurnLinks turns={f.turns} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None.</p>
              )}
            </section>
            <section>
              <h3 className="mb-1 text-sm font-semibold">Notable</h3>
              {out.notable ? <Markdown>{linkTurnRefs(out.notable)}</Markdown> : <p className="text-sm text-muted-foreground">Nothing.</p>}
            </section>
            {defs.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Fields</h3>
                <dl className="grid gap-x-8 gap-y-4 md:grid-cols-2">
                  {defs.map((d) => (
                    <div key={d.name} data-testid="coded-field">
                      <dt className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold">{d.name}</span>
                        {custom.has(d.name) && <Badge>custom</Badge>}
                        <span className="text-xs text-muted-foreground">{FIELD_TYPES[d.type].label}</span>
                      </dt>
                      <dd className="flex flex-col gap-1.5">
                        {slotsFor(d.scope).map((s) => (
                          <Entry key={s} def={d} label={s === "all" ? undefined : s} e={out.fields[d.name]?.[s]} />
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
