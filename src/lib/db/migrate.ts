import path from "node:path";
import { asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { turnMeasures } from "../analysis/measures";
import { PREDEFINED_FIELDS } from "../fields/library";
import { seedPresets } from "../presets/service";
import type { Db } from "./index";
import { fieldDefinitions, turns } from "./schema";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Applies pending migrations, then upserts the built-in field library and prompt presets. */
export async function migrateAndSeed(db: Db, driver: "pglite" | "postgres"): Promise<void> {
  if (driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  await seedFieldLibrary(db);
  await seedPresets(db);
  await backfillTurnMeasures(db);
}

/**
 * Turns saved before PR 3 have no computed measures. Fills them in from the
 * stored text, one conversation at a time. Does nothing once all are filled.
 */
export async function backfillTurnMeasures(db: Db): Promise<number> {
  const pending = await db.selectDistinct({ id: turns.conversationId }).from(turns).where(isNull(turns.emojiCount));
  let updated = 0;
  for (const { id } of pending) {
    const rows = await db
      .select({ id: turns.id, turnNumber: turns.turnNumber, text: turns.text, emojiCount: turns.emojiCount })
      .from(turns)
      .where(eq(turns.conversationId, id))
      .orderBy(asc(turns.turnNumber));
    const texts = new Map(rows.map((r) => [r.turnNumber, r.text]));
    for (const r of rows.filter((x) => x.emojiCount === null)) {
      const m = turnMeasures(texts, r.turnNumber);
      await db
        .update(turns)
        .set({ crossSimilarity: m.crossSimilarity, emojiCount: m.emojiCount, modelMentions: m.modelMentions })
        .where(inArray(turns.id, [r.id]));
      updated++;
    }
  }
  return updated;
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
