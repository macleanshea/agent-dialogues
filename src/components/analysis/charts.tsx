/**
 * Small server-rendered SVG charts. Single-series only, so color never has to
 * carry identity; hovering a turn shows its exact value (a native tooltip),
 * and every chart has a table view.
 */
import type { ReactNode } from "react";

const W = 560;
const H = 160;
const PAD = { left: 40, right: 12, top: 10, bottom: 24 };

export interface Point {
  x: number;
  y: number;
  /** Shown in the tooltip and the table. */
  note?: string;
}

function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

function TableView({ caption, header, rows }: { caption: string; header: [string, string, string?]; rows: Array<[ReactNode, ReactNode, ReactNode?]> }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">Show as table</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="w-full border-collapse tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {header.filter(Boolean).map((h) => (
                <th key={h} className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.filter((c) => c !== undefined).map((c, j) => (
                  <td key={j} className="border-b border-border px-2 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** A line by turn. `share` formats the y-axis as percentages on a 0–100% scale. */
export function TurnLineChart({
  title,
  points,
  format,
  testId,
}: {
  title: string;
  points: Point[];
  format: "int" | "dec" | "share";
  testId?: string;
}) {
  const fmt = (v: number) => (format === "share" ? `${Math.round(v * 100)}%` : format === "int" ? Math.round(v).toLocaleString("en-US") : v.toFixed(1));
  if (points.length === 0) {
    return (
      <figure data-testid={testId}>
        <figcaption className="text-sm font-medium">{title}</figcaption>
        <p className="py-6 text-xs text-muted-foreground">No data yet.</p>
      </figure>
    );
  }
  const maxX = Math.max(...points.map((p) => p.x));
  const minX = Math.min(...points.map((p) => p.x));
  const maxY = format === "share" ? 1 : Math.max(...points.map((p) => p.y)) * 1.1 || 1;
  const sx = (x: number) => PAD.left + (maxX === minX ? 0.5 : (x - minX) / (maxX - minX)) * (W - PAD.left - PAD.right);
  const sy = (y: number) => PAD.top + (1 - y / maxY) * (H - PAD.top - PAD.bottom);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const band = (W - PAD.left - PAD.right) / Math.max(1, maxX - minX + 1);
  const xTicks = [...new Set([minX, Math.round((minX + maxX) / 2), maxX])];

  return (
    <figure data-testid={testId}>
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full" role="img" aria-label={`${title}, by turn`}>
        {ticks(maxY).map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 6} y={sy(t) + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <text key={x} x={sx(x)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            T{x}
          </text>
        ))}
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.length <= 60 &&
          points.map((p) => <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={2.5} fill="var(--series-1)" stroke="var(--card)" strokeWidth={1} />)}
        {points.map((p) => (
          <rect key={`hit-${p.x}`} x={sx(p.x) - band / 2} y={PAD.top} width={Math.max(band, 6)} height={H - PAD.top - PAD.bottom} fill="transparent" className="hover:fill-[color-mix(in_srgb,var(--series-1)_10%,transparent)]">
            <title>{`T${p.x}: ${fmt(p.y)}${p.note ? ` (${p.note})` : ""}`}</title>
          </rect>
        ))}
      </svg>
      <TableView caption={title} header={["Turn", "Value", "Conversations"]} rows={points.map((p) => [`T${p.x}`, fmt(p.y), p.note ?? ""])} />
    </figure>
  );
}

/** Horizontal bars for a distribution, labeled "k of N". */
export function DistributionBars({ counts, n, testId }: { counts: Array<{ value: string; count: number }>; n: number; testId?: string }) {
  return (
    <ul className="flex flex-col gap-1" data-testid={testId}>
      {counts.map((c) => (
        <li key={c.value} className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate" title={c.value}>
            {c.value}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${n ? (c.count / n) * 100 : 0}%`, background: "var(--series-1)" }} />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">
            {c.count} of {n}
          </span>
        </li>
      ))}
    </ul>
  );
}
