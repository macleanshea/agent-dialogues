import type { NextRequest } from "next/server";
import { getDb } from "./db";
import { exportFileName, exportJson, exportMarkdown, exportResponse, findExportTarget } from "./export";
import { parseIndex } from "./ids";

/**
 * Shared by the two export routes. `?format=json` (default) or `?format=md`;
 * Markdown also takes `?v=2` for an analysis version other than the latest.
 */
export async function handleExport(req: NextRequest, exp: string, run: string | null): Promise<Response> {
  const expN = parseIndex(exp);
  const runN = run === null ? null : parseIndex(run);
  if (!expN || (run !== null && !runN)) return new Response("Not found", { status: 404 });
  const format = req.nextUrl.searchParams.get("format") === "md" ? "md" : "json";
  const v = parseIndex(req.nextUrl.searchParams.get("v") ?? "");
  const db = await getDb();
  const target = await findExportTarget(db, expN, runN);
  if (!target) return new Response("Not found", { status: 404 });
  const chunks = format === "md" ? exportMarkdown(db, target, v) : exportJson(db, target);
  return exportResponse(chunks, exportFileName(target, format), format);
}
