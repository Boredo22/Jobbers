import { defineConfig } from "drizzle-kit";
import { env } from "./src/lib/config";

// ---------------------------------------------------------------------------
// drizzle.config.ts — tells the drizzle-kit CLI where the schema is, where to
// write migrations, and how to reach the database.
//
//   pnpm --filter api db:generate   → diff schema.ts vs ./drizzle, write new SQL
//   pnpm --filter api db:migrate    → apply pending migrations to DATABASE_URL
//
// Importing `env` here means the same validated DATABASE_URL powers both the
// running server and the migration tooling — one source of truth for the
// connection string.
// ---------------------------------------------------------------------------
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: { url: env.DATABASE_URL },
	// Emit a readable summary of what each generated migration will do.
	verbose: true,
	// Ask before destructive operations rather than silently dropping data.
	strict: true,
});
