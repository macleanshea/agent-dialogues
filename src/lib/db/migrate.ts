import path from "node:path";
import { sql } from "drizzle-orm";
import { PREDEFINED_FIELDS } from "../fields/library";
import type { Db } from "./index";
import { fieldDefinitions } from "./schema";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Applies pending migrations, then upserts the built-in field library. */
export async function migrateAndSeed(db: Db, driver: "pglite" | "postgres"): Promise<void> {
  if (driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  await seedFieldLibrary(db);
}

/**
 * Inserts or updates every predefined field. Safe to run on every build.
 * Custom fields are never touched.
 */
export async function seedFieldLibrary(db: Db): Promise<void> {
  const rows = PREDEFINED_FIELDS.map((f, i) => ({
    name: f.name,
    type: f.type,
    scope: f.scope,
    options: f.options,
    definition: f.definition,
    builtin: true,
    group: f.group,
    presets: f.presets,
    sortOrder: i,
  }));
  await db
    .insert(fieldDefinitions)
    .values(rows)
    .onConflictDoUpdate({
      target: fieldDefinitions.name,
      set: {
        type: sql`excluded.type`,
        scope: sql`excluded.scope`,
        options: sql`excluded.options`,
        definition: sql`excluded.definition`,
        group: sql`excluded."group"`,
        presets: sql`excluded.presets`,
        sortOrder: sql`excluded.sort_order`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${fieldDefinitions.builtin} = true`,
    });
}
