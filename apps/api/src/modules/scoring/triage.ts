import type { AiSpend, TriageItem } from "@jobber/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
	aiRuns,
	applications,
	companies,
	fitScores,
	jobPostings,
} from "../../db/schema";
import { getActiveCompCeiling } from "../profile/service";

// ---------------------------------------------------------------------------
// scoring/triage.ts — the read side that feeds the /triage page (step 2.5).
//
// listTriage() is the one interesting query: it joins a score to its posting and
// company, then filters to the postings actually worth your attention right now —
// still open, not yet applied to, not dismissed — and sorts best-first. All the
// filtering lives in SQL (indexed, cheap) so the page just renders what it's handed.
// ---------------------------------------------------------------------------

/** Scored postings worth reviewing, best-first. Excludes closed/applied/dismissed. */
export async function listTriage(): Promise<TriageItem[]> {
	// The active profile's comp ceiling, if any — postings whose disclosed base is
	// above it are dropped as too senior to be worth the time. "Disclosed base" is
	// the scorer's extracted baseCompUsd, falling back to any structured comp_min;
	// postings with no comp signal at all are kept (we don't filter on missing data).
	const ceiling = await getActiveCompCeiling();
	const effectiveComp = sql`coalesce(${fitScores.baseCompUsd}, ${jobPostings.compMin})`;
	const withinCeiling =
		ceiling === null
			? undefined
			: sql`(${effectiveComp} is null or ${effectiveComp} <= ${ceiling})`;

	return (
		db
			.select({
				scoreId: fitScores.id,
				jobPostingId: jobPostings.id,
				companyId: jobPostings.companyId,
				companyName: companies.name,
				title: jobPostings.title,
				url: jobPostings.url,
				location: jobPostings.location,
				remote: jobPostings.remote,
				compMin: jobPostings.compMin,
				compMax: jobPostings.compMax,
				baseCompUsd: fitScores.baseCompUsd,
				score: fitScores.score,
				matchPoints: fitScores.matchPoints,
				gaps: fitScores.gaps,
				credentialGapFlag: fitScores.credentialGapFlag,
				rationale: fitScores.rationale,
				feedback: fitScores.feedback,
				createdAt: fitScores.createdAt,
			})
			.from(fitScores)
			.innerJoin(jobPostings, eq(fitScores.jobPostingId, jobPostings.id))
			.innerJoin(companies, eq(jobPostings.companyId, companies.id))
			// LEFT JOIN + IS NULL = "postings with no application row" (anti-join): drop
			// anything you've already applied to so triage only shows fresh decisions.
			.leftJoin(applications, eq(applications.jobPostingId, jobPostings.id))
			.where(
				and(
					eq(fitScores.dismissed, false),
					eq(jobPostings.status, "open"),
					isNull(applications.id),
					// Comp ceiling (undefined when unset → and() ignores it).
					withinCeiling,
					// Only the LATEST score per posting. Re-scoring (step 3.1) appends a
					// new fit_scores row rather than mutating the old one, so without
					// this a re-scored posting would show a stale duplicate card. The
					// correlated NOT EXISTS keeps a row only if no newer score exists.
					sql`not exists (select 1 from ${fitScores} fs2 where fs2.job_posting_id = ${fitScores.jobPostingId} and fs2.created_at > ${fitScores.createdAt})`,
				),
			)
			.orderBy(desc(fitScores.score), desc(fitScores.createdAt))
			.limit(100)
	);
}

/** Mark a score dismissed (hidden from triage). False if the id is unknown. */
export async function dismissScore(scoreId: string): Promise<boolean> {
	const updated = await db
		.update(fitScores)
		.set({ dismissed: true })
		.where(eq(fitScores.id, scoreId))
		.returning({ id: fitScores.id });
	return updated.length > 0;
}

/** Total AI spend for the current calendar month, from the ai_runs ledger. */
export async function aiSpendThisMonth(): Promise<AiSpend> {
	const [row] = await db
		.select({
			// est_cost is numeric → sum() comes back as a string; coalesce NULLs to 0.
			total: sql<string>`coalesce(sum(${aiRuns.estCost}), 0)`,
			runs: sql<number>`count(*)::int`,
		})
		.from(aiRuns)
		.where(sql`${aiRuns.createdAt} >= date_trunc('month', now())`);

	return {
		month: new Date().toISOString().slice(0, 7), // "YYYY-MM"
		totalUsd: Number(row?.total ?? 0),
		runs: row?.runs ?? 0,
	};
}
