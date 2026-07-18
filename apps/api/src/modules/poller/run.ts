import { and, eq, lt, ne, sql } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "../../db/client";
import { companies, jobPostings, pollRuns } from "../../db/schema";
import { adapters } from "./index";
import { isCandidate } from "./prefilter";

// ---------------------------------------------------------------------------
// run.ts — the poll orchestrator. This is the heart of Phase 1.
//
// One pass:
//   1. load active, pollable companies
//   2. for each (≤5 at once): fetch → normalize → UPSERT by (companyId,
//      externalId), then CLOSE any of that company's postings we didn't see
//   3. new postings run through the prefilter → candidate list
//   4. write a poll_runs audit row
//
// The two correctness rules that make polling safe to repeat forever:
//   • UPSERT on the dedupe key ⇒ running twice can't create duplicates.
//   • Close-missing is scoped to companies whose fetch SUCCEEDED ⇒ one dead
//     board can't mass-close everything.
// ---------------------------------------------------------------------------

const CONCURRENCY = 5; // polite cap on simultaneous board fetches

export type PollFailure = { company: string; reason: string };
export type PollCandidate = {
	companyId: string;
	company: string;
	title: string;
	url: string;
};

export type PollSummary = {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	companiesTotal: number;
	companiesOk: number;
	companiesFailed: number;
	newCount: number;
	candidateCount: number;
	failures: PollFailure[];
	candidates: PollCandidate[];
};

export async function runPoll(): Promise<PollSummary> {
	// A single timestamp for the whole run is the linchpin: everything upserted
	// this run gets lastSeenAt = startedAt, so "lastSeenAt < startedAt" precisely
	// means "not seen this run".
	const startedAt = new Date();

	const active = await db
		.select()
		.from(companies)
		.where(and(eq(companies.active, true), ne(companies.atsType, "manual")));

	const limit = pLimit(CONCURRENCY);

	let companiesOk = 0;
	let companiesFailed = 0;
	const failures: PollFailure[] = [];
	let newCount = 0;
	const candidates: PollCandidate[] = [];

	await Promise.all(
		active.map((c) =>
			limit(async () => {
				// Belt-and-suspenders: the query already excludes manual/inactive.
				if (c.atsType === "manual" || !c.atsToken) {
					companiesFailed++;
					failures.push({ company: c.name, reason: "no pollable token" });
					return;
				}

				try {
					// Narrowed to a pollable type here → indexes the adapter registry.
					const postings = await adapters[c.atsType](c.atsToken);

					// Dedupe within this board by externalId. A single INSERT ... ON
					// CONFLICT can't touch the same conflict target twice, so collapse
					// duplicates first (last one wins).
					const byExternal = new Map<string, (typeof postings)[number]>();
					for (const p of postings) byExternal.set(p.externalId, p);
					const unique = [...byExternal.values()];

					if (unique.length > 0) {
						const affected = await db
							.insert(jobPostings)
							.values(
								unique.map((p) => ({
									companyId: c.id,
									externalId: p.externalId,
									title: p.title,
									location: p.location,
									remote: p.remote,
									compMin: p.compMin,
									compMax: p.compMax,
									description: p.description,
									url: p.url,
									source: "poller" as const,
									contentHash: p.contentHash,
									status: "open" as const,
									firstSeenAt: startedAt,
									lastSeenAt: startedAt,
								})),
							)
							.onConflictDoUpdate({
								target: [jobPostings.companyId, jobPostings.externalId],
								// On an existing posting: refresh mutable fields to the freshly
								// fetched values, stamp lastSeenAt, and force it back open (a
								// reappeared posting revives). firstSeenAt is deliberately NOT
								// here, so the original discovery time is preserved.
								set: {
									lastSeenAt: startedAt,
									status: "open",
									title: sql`excluded.title`,
									location: sql`excluded.location`,
									remote: sql`excluded.remote`,
									compMin: sql`excluded.comp_min`,
									compMax: sql`excluded.comp_max`,
									description: sql`excluded.description`,
									url: sql`excluded.url`,
									contentHash: sql`excluded.content_hash`,
								},
							})
							.returning({
								title: jobPostings.title,
								location: jobPostings.location,
								remote: jobPostings.remote,
								url: jobPostings.url,
								firstSeenAt: jobPostings.firstSeenAt,
							});

						for (const row of affected) {
							// firstSeenAt >= startedAt ⇒ this row was INSERTED this run (an
							// update would have kept an earlier firstSeenAt). That's a
							// genuinely new posting.
							if (row.firstSeenAt.getTime() >= startedAt.getTime()) {
								newCount++;
								if (isCandidate(row)) {
									candidates.push({
										companyId: c.id,
										company: c.name,
										title: row.title,
										url: row.url,
									});
								}
							}
						}
					}

					// Close postings not seen this run — scoped to THIS company, reached
					// only because its fetch succeeded. One board erroring never closes
					// another board's (or its own) postings.
					await db
						.update(jobPostings)
						.set({ status: "closed" })
						.where(
							and(
								eq(jobPostings.companyId, c.id),
								eq(jobPostings.status, "open"),
								lt(jobPostings.lastSeenAt, startedAt),
							),
						);

					companiesOk++;
				} catch (err) {
					// Per-company isolation: log and move on. Never fatal to the run.
					companiesFailed++;
					failures.push({
						company: c.name,
						reason: err instanceof Error ? err.message : String(err),
					});
				}
			}),
		),
	);

	const finishedAt = new Date();

	// The audit row. (Notify + enqueue-for-scoring on `candidates` land in steps
	// 1.5 and 2.4 respectively.)
	await db.insert(pollRuns).values({
		startedAt,
		finishedAt,
		companiesOk,
		companiesFailed,
		newCount,
		candidateCount: candidates.length,
		failures,
	});

	return {
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		companiesTotal: active.length,
		companiesOk,
		companiesFailed,
		newCount,
		candidateCount: candidates.length,
		failures,
		candidates,
	};
}
