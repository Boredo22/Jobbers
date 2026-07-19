import type { CompanyListItem, CompanyPollStatus } from "@jobber/shared";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, jobPostings, pollRuns } from "../../db/schema";

// ---------------------------------------------------------------------------
// companies/service.ts — the read side for the /companies page.
//
// It answers "which boards are healthy?" by joining three facts:
//   • the company row (name, tier, ats type),
//   • how many of its postings are currently open (a group-by count),
//   • whether it errored in the MOST RECENT poll run (from poll_runs.failures).
// ---------------------------------------------------------------------------
export async function listCompanies(): Promise<CompanyListItem[]> {
	const companyRows = await db.select().from(companies).orderBy(companies.name);

	// Open-posting counts, one row per company, in a single grouped query.
	const openCounts = await db
		.select({
			companyId: jobPostings.companyId,
			count: sql<number>`count(*)::int`,
		})
		.from(jobPostings)
		.where(eq(jobPostings.status, "open"))
		.groupBy(jobPostings.companyId);
	const openByCompany = new Map(openCounts.map((r) => [r.companyId, r.count]));

	// The latest poll run's failures tell us which boards are currently failing.
	// failures is a jsonb array of { company, reason }; we key by company NAME
	// because that's what the poller recorded there.
	const [latestRun] = await db
		.select({ failures: pollRuns.failures })
		.from(pollRuns)
		.orderBy(desc(pollRuns.startedAt))
		.limit(1);
	const failingNames = new Set(
		(latestRun?.failures ?? []).map((f) => f.company),
	);
	const havePolled = latestRun !== undefined;

	return companyRows.map((c) => {
		let pollStatus: CompanyPollStatus;
		if (c.atsType === "manual") pollStatus = "manual";
		else if (!havePolled) pollStatus = "unknown";
		else pollStatus = failingNames.has(c.name) ? "failing" : "ok";

		return {
			id: c.id,
			name: c.name,
			atsType: c.atsType,
			fitGroup: c.fitGroup,
			active: c.active,
			pollStatus,
			openJobs: openByCompany.get(c.id) ?? 0,
		};
	});
}
