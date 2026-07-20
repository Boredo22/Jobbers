import type { JobListItem, JobsQuery } from "@jobber/shared";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, jobPostings } from "../../db/schema";
import { isCandidate, isUsLocation } from "../poller/prefilter";
import { getPrefilterSettings } from "../settings/service";

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

	// Attach the computed prefilter verdict to every row — with the keyword
	// lists loaded ONCE, not per row (they're the same for the whole request).
	const prefilter = await getPrefilterSettings();
	const withCandidate: JobListItem[] = rows.map((row) => ({
		...row,
		candidate: isCandidate(row, prefilter),
	}));

	// …then apply the computed filters only if the caller asked. Both are derived
	// from row fields (candidate from the prefilter, US from the location string),
	// so like `candidate` they live here in memory rather than in the WHERE.
	let result = withCandidate;
	if (query.candidate !== undefined)
		result = result.filter((r) => r.candidate === query.candidate);
	if (query.usOnly) result = result.filter((r) => isUsLocation(r.location));
	return result;
}
