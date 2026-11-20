import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Every page reads live data from the database, so pages are rendered
  // fresh on each request (see `dynamic` in each page) rather than cached.
  cacheComponents: false,
  // The in-process local database ships WebAssembly files; load it from
  // node_modules instead of bundling it.
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// withWorkflow compiles "use workflow" / "use step" functions and adds the
// internal routes Vercel Workflow calls (reachable only by Vercel's queue).
export default withWorkflow(nextConfig);
