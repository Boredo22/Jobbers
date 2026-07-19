import type {
	Application,
	ApplicationCreate,
	ApplicationEventType,
	ApplicationStatus,
	ApplicationWithEvents,
} from "@jobber/shared";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { applicationEvents, applications } from "../../db/schema";

// ---------------------------------------------------------------------------
// tracker/service.ts — the data logic behind the tracker routes.
//
// Design rule that runs through everything here (build plan): the event log is
// the SOURCE OF TRUTH; `applications.status` is a DENORMALIZED mirror kept in
// sync for fast reads. Every status change therefore does two writes — append
// an event, then update the column — and we wrap those two in a transaction so
// they can never drift apart.
// ---------------------------------------------------------------------------

/**
 * Map a pipeline *status* to the closest event *type*. The two enums don't line
 * up 1:1 (status has interview/offer/ghosted; the event type enum doesn't), so
 * anything without a dedicated event type is logged as a generic "note" whose
 * detail records the real transition. The column always holds the exact status;
 * the event type is just the best-fitting label for the timeline.
 */
export function statusToEventType(
	status: ApplicationStatus,
): ApplicationEventType {
	switch (status) {
		case "applied":
			return "applied";
		case "screen":
			return "screen_invite";
		case "rejected":
			return "rejection";
		default:
			return "note"; // interview | offer | ghosted
	}
}

/** Fetch applications (optionally one) and attach each one's ordered timeline. */
async function withEvents(
	rows: Application[],
): Promise<ApplicationWithEvents[]> {
	if (rows.length === 0) return [];

	const ids = rows.map((r) => r.id);
	// One query for every relevant event, then group in memory. Two round-trips
	// total regardless of row count — no N+1. (We don't use Drizzle's relational
	// `with:` because no relations() are declared in schema.ts.)
	const events = await db
		.select()
		.from(applicationEvents)
		.where(inArray(applicationEvents.applicationId, ids))
		.orderBy(asc(applicationEvents.occurredAt));

	const byApp = new Map<string, ApplicationWithEvents["events"]>();
	for (const id of ids) byApp.set(id, []);
	for (const e of events) byApp.get(e.applicationId)?.push(e);

	return rows.map((r) => ({ ...r, events: byApp.get(r.id) ?? [] }));
}

/** All applications, newest first, each with its event timeline. */
export async function listApplications(): Promise<ApplicationWithEvents[]> {
	const rows = await db
		.select()
		.from(applications)
		.orderBy(desc(applications.appliedAt));
	return withEvents(rows);
}

/**
 * Create an application and open its timeline with an "applied" event, in one
 * transaction. Returns the new row with its (single) event.
 */
export async function createApplication(
	input: ApplicationCreate,
): Promise<ApplicationWithEvents> {
	const appliedAt = input.appliedAt ?? new Date();

	const created = await db.transaction(async (tx) => {
		const [app] = await tx
			.insert(applications)
			.values({
				companyName: input.companyName,
				roleTitle: input.roleTitle,
				channel: input.channel,
				appliedAt,
				status: input.status ?? "applied",
				notes: input.notes ?? null,
				jobPostingId: input.jobPostingId ?? null,
				companyId: input.companyId ?? null,
				resumeVersionId: input.resumeVersionId ?? null,
			})
			.returning();
		// A single-row insert always returns one row, but strict index access
		// types it as possibly-undefined — assert it so the rest is non-null.
		if (!app) throw new Error("insert returned no row");

		await tx.insert(applicationEvents).values({
			applicationId: app.id,
			type: "applied",
			occurredAt: appliedAt,
			detail: null,
		});

		return app;
	});

	const [withTimeline] = await withEvents([created]);
	if (!withTimeline) throw new Error("failed to load created application");
	return withTimeline;
}

/**
 * Change an application's status: append the matching event AND update the
 * denormalized column, atomically. Returns null if no such application exists.
 */
export async function updateApplicationStatus(
	id: string,
	status: ApplicationStatus,
	detail?: string,
): Promise<ApplicationWithEvents | null> {
	const updated = await db.transaction(async (tx) => {
		// Guard first: is there a row to update? (Inside the tx so the check and
		// the writes are one unit.)
		const [existing] = await tx
			.select({ id: applications.id })
			.from(applications)
			.where(eq(applications.id, id));
		if (!existing) return null;

		await tx.insert(applicationEvents).values({
			applicationId: id,
			type: statusToEventType(status),
			occurredAt: new Date(),
			// Record the exact status transition; for "note"-typed events this is
			// the only place the real status label lives on the timeline.
			detail: detail ?? `status → ${status}`,
		});

		const [app] = await tx
			.update(applications)
			.set({ status })
			.where(eq(applications.id, id))
			.returning();
		// Existence was just checked in this same tx, so the update hit a row.
		if (!app) throw new Error("update returned no row");
		return app;
	});

	if (!updated) return null; // no such application
	const [withTimeline] = await withEvents([updated]);
	if (!withTimeline) throw new Error("failed to load updated application");
	return withTimeline;
}
