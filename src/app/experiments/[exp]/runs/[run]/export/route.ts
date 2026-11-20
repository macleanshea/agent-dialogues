import type { NextRequest } from "next/server";
import { handleExport } from "@/lib/export-route";

/** Download one run: /experiments/4/runs/2/export?format=json or ?format=md */
export async function GET(req: NextRequest, ctx: RouteContext<"/experiments/[exp]/runs/[run]/export">) {
  const { exp, run } = await ctx.params;
  return handleExport(req, exp, run);
}
