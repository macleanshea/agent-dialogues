import { defineConfig } from "drizzle-kit";

// Used only to generate migration files from src/lib/db/schema.ts:
//   npm run db:generate
// Migrations are applied by scripts/migrate.ts during the build.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
});
