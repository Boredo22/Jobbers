import { promptVersion, renderPrompt, TAILOR_POSTING_PROMPT } from "@jobber/ai";
import {
	type TailoredDraft,
	type TailoredDraftRecord,
	TailoredDraftSchema,
} from "@jobber/shared";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
	applications,
	companies,
	jobPostings,
	profileVersions,
	resumeVersions,
	tailoredDrafts,
} from "../../db/schema";
import { createProvider, logAiRun } from "../../lib/ai";

// ---------------------------------------------------------------------------
// tailor/service.ts — tailor-to-posting (Phase 3, step 3.2b).
//
// From a single high-scoring posting, ask the model for concrete resume edits
// (before/after, so the UI can diff them) plus a draft outreach note, tuned to
// THAT posting. Unlike the general resume review, tailoring needs the real
// resume text — you can't rewrite a placeholder — so a missing active resume is
// a clear, caught error, not a silent stub.
//
// House rule (CLAUDE.md): AI drafts, human finishes. Everything here is saved as
// a draft attached to the application; nothing is ever auto-sent.
// ---------------------------------------------------------------------------

/** Raised when there's no active resume to tailor. Routes map it to a 409. */
export class NoActiveResumeError extends Error {
	constructor() {
		super("No active resume to tailor — upload one on the Resume page first.");
		this.name = "NoActiveResumeError";
	}
}

/** The active resume's id + text, or null when nothing is active. */
async function activeResume(): Promise<{ id: string; text: string } | null> {
	const [row] = await db
		.select({ id: resumeVersions.id, text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.active, true))
		.limit(1);
	return row ?? null;
}

/** The active profile rendered to prose for the prompt (or a placeholder). */
async function activeProfileText(): Promise<string> {
	const [row] = await db
		.select()
		.from(profileVersions)
		.where(eq(profileVersions.active, true))
		.limit(1);
	if (!row) return "(No ideal-job profile defined yet.)";
	const criteria = (row.rubric?.criteria ?? [])
		.map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
		.join("\n");
	return `${row.northStar}\n\nWhat matters, and how much:\n${criteria}`;
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

/** The posting joined with its company name, or null if the id is unknown. */
async function loadPosting(jobPostingId: string) {
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
	return posting ?? null;
}

/**
 * Generate a tailored draft for one posting. Returns the draft AND the resume
 * version it was based on (so a later save can record provenance). Not persisted
 * — the human reviews/edits before saving. Uses the "large" tier: this is a rare,
 * quality-critical call, like the resume review and profile proposal.
 *
 * Throws if the posting doesn't exist, or NoActiveResumeError if nothing's active.
 */
export async function tailorPosting(jobPostingId: string): Promise<{
	draft: TailoredDraft;
	resumeVersionId: string;
	modelUsed: string;
	promptVersion: string;
}> {
	const posting = await loadPosting(jobPostingId);
	if (!posting)
		throw new Error(`tailorPosting: posting ${jobPostingId} not found`);

	const resume = await activeResume();
	if (!resume) throw new NoActiveResumeError();

	const prompt = renderPrompt(TAILOR_POSTING_PROMPT, {
		profile: await activeProfileText(),
		jd: renderJd(posting),
		resume: resume.text,
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: TailoredDraftSchema,
		schemaName: "tailored_draft",
		tier: "large",
		// Edits (each with before/after text) plus an outreach note is verbose —
		// give the tool-call JSON room so it doesn't truncate mid-array.
		maxTokens: 4096,
	});
	await logAiRun("tailor", result);

	return {
		draft: result.data,
		resumeVersionId: resume.id,
		modelUsed: result.model,
		promptVersion: promptVersion(TAILOR_POSTING_PROMPT),
	};
}

/** Recombine a tailored_drafts row into the flat wire shape. */
function toRecord(
	row: typeof tailoredDrafts.$inferSelect,
): TailoredDraftRecord {
	return {
		id: row.id,
		jobPostingId: row.jobPostingId,
		applicationId: row.applicationId,
		resumeVersionId: row.resumeVersionId,
		summary: row.summary,
		edits: row.edits,
		keywords: row.keywords,
		outreachNote: row.outreachNote,
		modelUsed: row.modelUsed,
		promptVersion: row.promptVersion,
		createdAt: row.createdAt,
	};
}

/**
 * Save an (edited) tailored draft as a new row, attached to the posting and — if
 * an application already exists for that posting — to the application too, which
 * is what makes the draft reachable from the pipeline. Re-resolves the active
 * resume at save time to record which version was in play. Throws on unknown
 * posting / NoActiveResumeError, so a save can't dangle off nothing.
 */
export async function saveTailoredDraft(
	jobPostingId: string,
	draft: TailoredDraft,
): Promise<TailoredDraftRecord> {
	const posting = await loadPosting(jobPostingId);
	if (!posting)
		throw new Error(`saveTailoredDraft: posting ${jobPostingId} not found`);

	const resume = await activeResume();
	if (!resume) throw new NoActiveResumeError();

	// Attach to the application for this posting, if one exists (newest first).
	const [app] = await db
		.select({ id: applications.id })
		.from(applications)
		.where(eq(applications.jobPostingId, jobPostingId))
		.orderBy(desc(applications.appliedAt))
		.limit(1);

	const [row] = await db
		.insert(tailoredDrafts)
		.values({
			jobPostingId,
			applicationId: app?.id ?? null,
			resumeVersionId: resume.id,
			summary: draft.summary,
			edits: draft.edits,
			keywords: draft.keywords,
			outreachNote: draft.outreachNote,
			modelUsed: "human-edited", // the saved copy may differ from the raw model output
			promptVersion: promptVersion(TAILOR_POSTING_PROMPT),
		})
		.returning();
	if (!row) throw new Error("saveTailoredDraft: insert returned no row");
	return toRecord(row);
}

/** The latest saved draft for a posting, or null if none has been saved. */
export async function latestDraftForPosting(
	jobPostingId: string,
): Promise<TailoredDraftRecord | null> {
	const [row] = await db
		.select()
		.from(tailoredDrafts)
		.where(eq(tailoredDrafts.jobPostingId, jobPostingId))
		.orderBy(desc(tailoredDrafts.createdAt))
		.limit(1);
	return row ? toRecord(row) : null;
}
