import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/config";
import * as schema from "./schema";

// ---------------------------------------------------------------------------
// client.ts — the one connected database handle the whole API shares.
//
// Two layers:
//   • postgres(...) is the raw driver (postgres.js) — it owns the TCP
//     connection pool to Postgres.
//   • drizzle(...) wraps that driver in the typed query builder. Passing
//     `{ schema }` is what makes relational queries and `db.query.*` aware of
//     your tables and their relations.
//
// Import `db` anywhere you need the database. It's a module-level singleton, so
// the pool is created once for the process — you don't open a connection per
// request the way naive code sometimes does.
// ---------------------------------------------------------------------------
// Exported so one-off scripts (e.g. the seed) can close the pool and let the
// process exit cleanly. Long-lived code (the server) never needs to end it.
export const queryClient = postgres(env.DATABASE_URL);

export const db = drizzle(queryClient, { schema });
