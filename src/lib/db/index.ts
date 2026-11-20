import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { migrateAndSeed } from "./migrate";

/**
 * One database interface, two engines:
 * - Postgres (Neon) when DATABASE_URL is set. That is every Vercel deployment.
 * - PGlite (Postgres compiled to WebAssembly, in-process) otherwise, for
 *   local development and tests. Stored in .pglite/ by default, or in memory
 *   with PGLITE_DIR=memory://.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, typeof schema, any>;

const globalForDb = globalThis as unknown as { __agentDialoguesDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__agentDialoguesDb) {
    globalForDb.__agentDialoguesDb = createDb().catch((err) => {
      globalForDb.__agentDialoguesDb = undefined;
      throw err;
    });
  }
  return globalForDb.__agentDialoguesDb;
}

async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // prepare: false keeps this compatible with Neon's pooled connection string.
    const client = postgres(url, { prepare: false, max: 5 });
    return drizzle(client, { schema }) as unknown as Db;
  }
  if (process.env.VERCEL) {
    throw new Error("DATABASE_URL is not set for this Vercel deployment.");
  }
  const db = await createPgliteDb(process.env.PGLITE_DIR ?? ".pglite");
  // Neon is migrated during the Vercel build. PGlite is migrated here, on first use.
  await migrateAndSeed(db, "pglite");
  return db;
}

export async function createPgliteDb(dataDir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(dataDir);
  return drizzle(client, { schema }) as unknown as Db;
}

export { schema };
