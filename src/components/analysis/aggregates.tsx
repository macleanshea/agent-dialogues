import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { Aggregate, FieldAggregate, Slot } from "@/lib/analysis/fields";
import { FIELD_TYPES } from "@/lib/analysis/fields";
import { conversationHref, conversationId } from "@/lib/ids";
import { DistributionBars, TurnLineChart } from "./charts";

const SLOT_LABEL: Record<Slot, string> = { all: "", A: "Speaker A", B: "Speaker B" };

function AggregateView({ a, field, slot, exp, run }: { a: Aggregate; field: string; slot: Slot; exp: number; run: number }) {
  const id = `agg-${field}-${slot}`;
  switch (a.kind) {
    case "yes_no":
      return (
        <p className="text-sm" data-testid={id}>
          <span className="text-lg font-semibold tabular-nums">
            {a.yes} of {a.n}
          </span>{" "}
          <span className="text-muted-foreground">
            conversations · median first turn {a.medianFirstTurn !== null ? `T${a.medianFirstTurn}` : "—"}
          </span>
        </p>
      );
    case "distribution":
      return (
        <div className="flex flex-col gap-1">
          {a.part && <div className="text-xs font-medium text-muted-foreground capitalize">{a.part}</div>}
          <DistributionBars counts={a.counts} n={a.n} testId={id} />
        </div>
      );
    case "scale":
      return (
        <p className="text-sm" data-testid={id}>
          <span className="text-lg font-semibold tabular-nums">Median {a.median ?? "—"}</span>{" "}
          <span className="text-muted-foreground">
            · range {a.min ?? "—"} to {a.max ?? "—"} · {a.answered} of {a.n} gave a value
            {a.min_label || a.max_label ? ` · 1 = ${a.min_label ?? "low"}, 5 = ${a.max_label ?? "high"}` : ""}
          </span>
        </p>
      );
    case "frequency":
      return a.counts.length ? (
        <DistributionBars counts={a.counts.slice(0, 12)} n={a.n} testId={id} />
      ) : (
        <p className="text-xs text-muted-foreground">No tags.</p>
      );
    case "texts":
      return (
        <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-xs" data-testid={id}>
          {a.items.map((t) => (
            <li key={t.conversation}>
              <Link href={conversationHref(exp, run, t.conversation)} className="font-mono hover:underline">
                {conversationId(t.conversation)}
              </Link>{" "}
              {t.text}
            </li>
          ))}
          {a.items.length === 0 && <li className="text-muted-foreground">No values.</li>}
        </ul>
      );
    case "turn_ranges":
      return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid={id}>
          {a.series.map((s) => (
            <TurnLineChart
              key={s.value}
              title={s.value}
              format="share"
              points={s.points.map((p) => ({ x: p.turn, y: p.share, note: `${Math.round(p.share * p.n)} of ${p.n}` }))}
            />
          ))}
        </div>
      );
  }
}

/** Every selected field, aggregated by its type. Built-in and custom fields render the same way. */
export function FieldAggregates({ aggregates, exp, run, custom }: { aggregates: FieldAggregate[]; exp: number; run: number; custom: Set<string> }) {
  if (aggregates.length === 0) return <p className="text-sm text-muted-foreground">No fields were selected for this analysis.</p>;
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      {aggregates.map(({ def, slots }) => {
        const wide = def.type === "turn_ranges";
        return (
          <section key={def.name} className={wide ? "lg:col-span-2" : undefined} data-testid="field-aggregate">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-mono text-sm font-semibold">{def.name}</h3>
              {custom.has(def.name) && <Badge>custom</Badge>}
              <span className="text-xs text-muted-foreground">
                {FIELD_TYPES[def.type].label} · {def.scope === "per_speaker" ? "per speaker" : "conversation"}
              </span>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{def.definition}</p>
            <div className={slots.length > 1 && !wide ? "grid gap-4 sm:grid-cols-2" : "flex flex-col gap-4"}>
              {slots.map(({ slot, aggregates: aggs }) => (
                <div key={slot} className="flex flex-col gap-2">
                  {SLOT_LABEL[slot] && <div className="text-xs font-semibold">{SLOT_LABEL[slot]}</div>}
                  {aggs.map((a, i) => (
                    <AggregateView key={i} a={a} field={def.name} slot={slot} exp={exp} run={run} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
