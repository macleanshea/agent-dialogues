import type { NextConfig } from "next";

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

export default nextConfig;
