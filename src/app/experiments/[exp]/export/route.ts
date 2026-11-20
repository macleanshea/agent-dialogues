import type { NextRequest } from "next/server";
import { handleExport } from "@/lib/export-route";

/** Download a whole experiment: /experiments/4/export?format=json or ?format=md */
export async function GET(req: NextRequest, ctx: RouteContext<"/experiments/[exp]/export">) {
  const { exp } = await ctx.params;
  return handleExport(req, exp, null);
}
