/**
 * Runs before `next build` (see package.json). Applies database migrations and
 * seeds the built-in field library.
 *
 * - On Vercel, DATABASE_URL points at the Neon branch for this deployment, so
 *   each preview gets its own migrated database.
 * - Without DATABASE_URL (CI, local), there is nothing to migrate at build
 *   time: the local PGlite database migrates itself on first use.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/lib/db/schema";
import { migrateAndSeed } from "../src/lib/db/migrate";
import type { Db } from "../src/lib/db";

async function main() {
  // The unpooled URL is better for migrations when the integration provides it.
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL) {
      console.error("DATABASE_URL is not set for this Vercel build. Is the Neon integration connected?");
      process.exit(1);
    }
    console.log("migrate: no DATABASE_URL, skipping (local PGlite migrates on first use).");
    return;
  }
  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await migrateAndSeed(drizzle(client, { schema }) as unknown as Db, "postgres");
    console.log("migrate: migrations applied and field library seeded.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("migrate: failed", err);
  process.exit(1);
});
