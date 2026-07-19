import type { JobListItem, JobsQuery } from "@jobber/shared";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, jobPostings } from "../../db/schema";
import { isCandidate } from "../poller/prefilter";

// ---------------------------------------------------------------------------
// jobs/service.ts — read side of the job postings.
//
// The one interesting bit: `candidate` is NOT a stored column. It's the
// prefilter's verdict, computed on the fly from title/location/remote. So the
// SQL WHERE handles the cheap indexed filters (status, companyId) and we apply
// the candidate filter in memory after joining company names. At a few hundred
// postings that's trivially fast; if the table ever grew huge we'd persist the
// flag at upsert time instead.
// ---------------------------------------------------------------------------
export async function listJobs(query: JobsQuery): Promise<JobListItem[]> {
	// Collect the SQL-level conditions, skipping any filter the caller omitted.
	const conditions: SQL[] = [];
	if (query.status) conditions.push(eq(jobPostings.status, query.status));
	if (query.companyId)
		conditions.push(eq(jobPostings.companyId, query.companyId));

	const rows = await db
		.select({
			id: jobPostings.id,
			companyId: jobPostings.companyId,
			companyName: companies.name,
			title: jobPostings.title,
			location: jobPostings.location,
			remote: jobPostings.remote,
			compMin: jobPostings.compMin,
			compMax: jobPostings.compMax,
			url: jobPostings.url,
			status: jobPostings.status,
			source: jobPostings.source,
			firstSeenAt: jobPostings.firstSeenAt,
			lastSeenAt: jobPostings.lastSeenAt,
		})
		.from(jobPostings)
		.innerJoin(companies, eq(jobPostings.companyId, companies.id))
		// spread-into-and: 0 conditions → undefined (no WHERE); 1+ → AND them.
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(jobPostings.firstSeenAt));

	// Attach the computed prefilter verdict to every row…
	const withCandidate: JobListItem[] = rows.map((row) => ({
		...row,
		candidate: isCandidate(row),
	}));

	// …then apply the candidate filter only if the caller asked for it. `=== true`
	// / `=== false` both filter; `undefined` means "don't filter on this axis".
	if (query.candidate === undefined) return withCandidate;
	return withCandidate.filter((r) => r.candidate === query.candidate);
}
