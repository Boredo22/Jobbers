import { promptVersion, renderPrompt, SCORE_JOB_PROMPT } from "@jobber/ai";
import { FitScoreSchema, type ScoreVerdict } from "@jobber/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
	companies,
	fitScores,
	jobPostings,
	profileVersions,
	resumeVersions,
} from "../../db/schema";
import { createProvider, logAiRun } from "../../lib/ai";
import { notify } from "../../lib/notify";

// ---------------------------------------------------------------------------
// scoring/service.ts — turn one posting into one scored fit_scores row.
//
// scorePosting() is the business logic that sits on top of the step-2.1/2.2
// provider: it gathers the three inputs the prompt needs (the posting, the
// candidate's active resume, the active ideal-job profile), renders the
// versioned prompt, asks the provider for a schema-validated FitScore, writes
// the row, and logs the cost. The queue/worker (queue.ts) decides *when* to call
// this; here we only care about scoring *one*.
//
// Phase-2 reality: there's no resume or profile in the DB yet (those are built in
// Phase 3, steps 3.1–3.2). So both fall back to honest placeholders and the score
// leans on the JD + prefilter signal. When Phase 3 lands a real profile/resume,
// scores sharpen automatically — and the "re-score open candidates" button
// re-runs this against the new profile version.
// ---------------------------------------------------------------------------

const RESUME_FALLBACK =
	"(No resume on file yet — Phase 3 adds resume upload. Judge on role/skill fit from the posting.)";
const PROFILE_FALLBACK =
	"(No ideal-job profile defined yet — Phase 3 adds it. Score primarily on general engineering fit and any constraints visible in the posting.)";

/** The single active resume's extracted text, or a placeholder if none exists. */
async function activeResumeText(): Promise<string> {
	const [row] = await db
		.select({ text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.active, true))
		.limit(1);
	return row?.text ?? RESUME_FALLBACK;
}

/**
 * The active profile version rendered to prose for the prompt, plus its id so the
 * score records which profile graded it (null when no profile exists yet).
 */
async function activeProfile(): Promise<{ text: string; id: string | null }> {
	const [row] = await db
		.select()
		.from(profileVersions)
		.where(eq(profileVersions.active, true))
		.limit(1);
	if (!row) return { text: PROFILE_FALLBACK, id: null };

	const criteria = (row.rubric?.criteria ?? [])
		.map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
		.join("\n");

	// Surface the hard filters (comp floor/ceiling, location, remote) to the model
	// so the score reflects the dealbreakers, not just the weighted criteria.
	const hf = (row.rubric?.hardFilters ?? {}) as Record<string, unknown>;
	const floor = typeof hf.compFloor === "number" ? `$${hf.compFloor}` : "none";
	const ceiling =
		typeof hf.compCeiling === "number" ? `$${hf.compCeiling}` : "none";
	const loc =
		typeof hf.locationRule === "string" ? hf.locationRule : "unspecified";
	const remote =
		hf.remoteRequired === true ? "remote required" : "remote optional";
	const filters = `Hard filters — comp floor: ${floor}; comp ceiling: ${ceiling} (roles clearly above the ceiling are too senior — a weak fit); location: ${loc}; ${remote}.`;

	const text = `${row.northStar}\n\n${filters}\n\nWhat matters, and how much:\n${criteria}`;
	return { text, id: row.id };
}

/** Assemble the posting into the plain-text JD block the prompt expects. */
function renderJd(p: {
	title: string;
	companyName: string;
	location: string | null;
	remote: boolean | null;
	compMin: number | null;
	compMax: number | null;
	description: string | null;
	url: string;
}): string {
	const comp =
		p.compMin || p.compMax
			? `Comp: ${p.compMin ?? "?"}–${p.compMax ?? "?"}`
			: "Comp: not disclosed";
	const remote =
		p.remote === null
			? "Remote: unclear"
			: `Remote: ${p.remote ? "yes" : "no"}`;
	return [
		`Title: ${p.title}`,
		`Company: ${p.companyName}`,
		`Location: ${p.location ?? "unspecified"}   ${remote}`,
		comp,
		`URL: ${p.url}`,
		"",
		p.description ?? "(no description provided)",
	].join("\n");
}

/** What a completed scoring produces — enough for the worker to notify on. */
export type ScoreResult = {
	scoreId: string;
	score: number;
	company: string;
	title: string;
	url: string;
	rationale: string;
};

/**
 * Score one posting end to end. Throws if the posting doesn't exist or the
 * provider fails (the caller — the worker — catches and records the failure).
 */
export async function scorePosting(jobPostingId: string): Promise<ScoreResult> {
	// The posting joined with its company name.
	const [posting] = await db
		.select({
			id: jobPostings.id,
			title: jobPostings.title,
			location: jobPostings.location,
			remote: jobPostings.remote,
			compMin: jobPostings.compMin,
			compMax: jobPostings.compMax,
			description: jobPostings.description,
			url: jobPostings.url,
			companyName: companies.name,
		})
		.from(jobPostings)
		.innerJoin(companies, eq(jobPostings.companyId, companies.id))
		.where(eq(jobPostings.id, jobPostingId))
		.limit(1);
	if (!posting)
		throw new Error(`scorePosting: posting ${jobPostingId} not found`);

	const [resume, profile] = await Promise.all([
		activeResumeText(),
		activeProfile(),
	]);

	const prompt = renderPrompt(SCORE_JOB_PROMPT, {
		profile: profile.text,
		resume,
		jd: renderJd(posting),
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: FitScoreSchema,
		schemaName: "fit_score",
		tier: "small",
		maxTokens: 1024,
	});

	// Record the cost/audit row (fire-and-forget on the ledger side is fine, but
	// awaiting keeps ordering deterministic for the checkpoint).
	await logAiRun("score", result);

	const fit = result.data;
	const [row] = await db
		.insert(fitScores)
		.values({
			jobPostingId: posting.id,
			profileVersionId: profile.id,
			score: fit.score,
			matchPoints: fit.matchPoints,
			gaps: fit.gaps,
			credentialGapFlag: fit.credentialGapFlag,
			rationale: fit.rationale,
			baseCompUsd: fit.baseCompUsd,
			modelUsed: result.model,
			promptVersion: promptVersion(SCORE_JOB_PROMPT),
		})
		.returning({ id: fitScores.id });

	return {
		scoreId: row?.id ?? "",
		score: fit.score,
		company: posting.companyName,
		title: posting.title,
		url: posting.url,
		rationale: fit.rationale,
	};
}

/**
 * Record 👍/👎 (and an optional note) on a score. Returns false if the score id
 * doesn't exist, so the route can answer 404.
 */
export async function recordFeedback(
	scoreId: string,
	verdict: ScoreVerdict,
	note?: string,
): Promise<boolean> {
	const updated = await db
		.update(fitScores)
		.set({ feedback: verdict, feedbackNote: note ?? null })
		.where(eq(fitScores.id, scoreId))
		.returning({ id: fitScores.id });
	return updated.length > 0;
}

/**
 * Fire a phone push for a high-scoring hit. Only called for score ≥ threshold;
 * notify() no-ops when ntfy is unconfigured and never throws.
 */
export async function notifyHighScore(r: ScoreResult): Promise<void> {
	await notify({
		title: `⭐ ${r.score.toFixed(1)} — ${r.company}`,
		message: `${r.title}\n\n${r.rationale}`,
		priority: "high",
		tags: ["star"],
		click: r.url,
	});
}
