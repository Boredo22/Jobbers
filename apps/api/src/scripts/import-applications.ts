import { readFileSync } from "node:fs";
import {
	ApplicationChannelSchema,
	ApplicationStatusSchema,
} from "@jobber/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, queryClient } from "../db/client";
import { applicationEvents, applications, companies } from "../db/schema";

// ---------------------------------------------------------------------------
// import-applications.ts — one-time load of your existing pipeline from
// data/applications.json into the applications + application_events tables.
//
// Run:  pnpm --filter api import:applications
//
// Each source row becomes:
//   • one `applications` row (linked to a seeded company by name when possible),
//   • one "applied" event dated appliedAt,
//   • a "rejection" event dated rejectedAt IF the row was rejected.
//
// Idempotent: re-running skips any (companyName, roleTitle) already present, so
// a second run inserts nothing. There's no DB unique constraint on applications
// (you legitimately apply to the same company twice), so we dedupe in code
// against a snapshot of what's already there.
// ---------------------------------------------------------------------------

// The Zod boundary (CLAUDE.md §4): the JSON file is external input, validated
// before a single value reaches the DB. Dates arrive as "YYYY-MM-DD" strings;
// z.coerce.date turns them into real Date objects.
const ImportRowSchema = z.object({
	companyName: z.string().min(1),
	roleTitle: z.string().min(1),
	channel: ApplicationChannelSchema,
	appliedAt: z.coerce.date(),
	status: ApplicationStatusSchema.default("applied"),
	rejectedAt: z.coerce.date().optional(),
	notes: z.string().optional(),
});
type ImportRow = z.infer<typeof ImportRowSchema>;

const ImportFileSchema = z.array(ImportRowSchema);

// A stable de-dupe key for a source row. Lowercased so casing drift in the JSON
// doesn't create phantom duplicates.
function key(companyName: string, roleTitle: string): string {
	return `${companyName.toLowerCase()}|||${roleTitle.toLowerCase()}`;
}

async function importApplications() {
	const dataPath = new URL("../../data/applications.json", import.meta.url);
	const raw: unknown = JSON.parse(readFileSync(dataPath, "utf8"));
	const rows: ImportRow[] = ImportFileSchema.parse(raw);

	// Build a name → companyId lookup so imported rows link to seeded companies.
	// Lowercased keys for case-insensitive matching. Off-poller applications to
	// companies we don't track simply stay unlinked (companyId = null); the
	// snapshot columns keep the row self-describing regardless.
	const companyRows = await db
		.select({ id: companies.id, name: companies.name })
		.from(companies);
	const companyIdByName = new Map<string, string>();
	for (const c of companyRows) companyIdByName.set(c.name.toLowerCase(), c.id);

	// Snapshot existing applications so re-runs are no-ops.
	const existingRows = await db
		.select({
			companyName: applications.companyName,
			roleTitle: applications.roleTitle,
		})
		.from(applications);
	const existing = new Set(
		existingRows.map((r) => key(r.companyName, r.roleTitle)),
	);

	let inserted = 0;
	let skipped = 0;

	for (const row of rows) {
		if (existing.has(key(row.companyName, row.roleTitle))) {
			skipped++;
			continue;
		}

		// One transaction per application: the row and its events land together or
		// not at all — no half-imported application with a missing timeline.
		await db.transaction(async (tx) => {
			const [app] = await tx
				.insert(applications)
				.values({
					companyId: companyIdByName.get(row.companyName.toLowerCase()) ?? null,
					companyName: row.companyName,
					roleTitle: row.roleTitle,
					channel: row.channel,
					appliedAt: row.appliedAt,
					status: row.status,
					notes: row.notes ?? null,
				})
				.returning({ id: applications.id });
			if (!app) throw new Error("insert returned no row");

			// The founding event — every application starts by being applied to.
			await tx.insert(applicationEvents).values({
				applicationId: app.id,
				type: "applied",
				occurredAt: row.appliedAt,
				detail: null,
			});

			// A rejection event when the source row records one (explicit rejectedAt
			// or a status of "rejected"). Dated to rejectedAt, falling back to the
			// applied date if only the status was given.
			if (row.rejectedAt || row.status === "rejected") {
				await tx.insert(applicationEvents).values({
					applicationId: app.id,
					type: "rejection",
					occurredAt: row.rejectedAt ?? row.appliedAt,
					detail: null,
				});
			}
		});

		// Guard against duplicate (companyName, roleTitle) pairs *within* the file.
		existing.add(key(row.companyName, row.roleTitle));
		inserted++;
	}

	// A quick sanity count straight from the DB.
	const [countRow] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(applications);
	const total = countRow?.total ?? 0;

	console.log(
		`Import complete: ${rows.length} rows in file, ${inserted} inserted, ${skipped} already present. Applications table now holds ${total}.`,
	);
}

try {
	await importApplications();
} catch (err) {
	console.error("Import failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
