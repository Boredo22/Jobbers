import { promptVersion, renderPrompt, TAILOR_POSTING_PROMPT } from "@jobber/ai";
import {
	type TailoredDraft,
	type TailoredDraftRecord,
	TailoredDraftSchema,
	type TailorRequest,
} from "@jobber/shared";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
	applications,
	companies,
	jobPostings,
	profiles,
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

/** Raised when there's no resume at all to tailor from. Routes map it to a 409. */
export class NoActiveResumeError extends Error {
	constructor() {
		super("No active resume to tailor — upload one on the Resume page first.");
		this.name = "NoActiveResumeError";
	}
}

/** Raised when an explicitly-requested base version id doesn't exist. → 404. */
export class ResumeNotFoundError extends Error {
	constructor(id: string) {
		super(`Resume version ${id} not found.`);
		this.name = "ResumeNotFoundError";
	}
}

/**
 * Pure base-precedence rule (unit-tested): an explicit pick wins, else the
 * track's own resume, else the globally-active one. Returns null when none of
 * the three is set — the caller turns that into NoActiveResumeError. Kept pure
 * (no DB) so the precedence itself is testable in isolation.
 */
export function pickBaseVersionId(opts: {
	explicit?: string | null;
	trackResumeVersionId?: string | null;
	activeResumeVersionId?: string | null;
}): string | null {
	return (
		opts.explicit ??
		opts.trackResumeVersionId ??
		opts.activeResumeVersionId ??
		null
	);
}

/** The globally-active resume's id + text, or null when nothing is active. */
async function activeResume(): Promise<{ id: string; text: string } | null> {
	const [row] = await db
		.select({ id: resumeVersions.id, text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.active, true))
		.limit(1);
	return row ?? null;
}

/**
 * Resolve which resume version to tailor from, honoring pickBaseVersionId's
 * precedence, and return its id + text. Throws ResumeNotFoundError if an
 * explicitly-chosen id doesn't exist, NoActiveResumeError if nothing resolves.
 */
async function resolveBase(
	req: TailorRequest,
): Promise<{ id: string; text: string }> {
	// The track's own resume, if a profile (track) was named.
	let trackResumeVersionId: string | null = null;
	if (req.profileId) {
		const [p] = await db
			.select({ rv: profiles.resumeVersionId })
			.from(profiles)
			.where(eq(profiles.id, req.profileId))
			.limit(1);
		trackResumeVersionId = p?.rv ?? null;
	}

	const active = await activeResume();
	const chosenId = pickBaseVersionId({
		explicit: req.resumeVersionId ?? null,
		trackResumeVersionId,
		activeResumeVersionId: active?.id ?? null,
	});
	if (!chosenId) throw new NoActiveResumeError();

	// Reuse the text we already loaded if the active one is the pick.
	if (active && chosenId === active.id) return active;

	const [row] = await db
		.select({ id: resumeVersions.id, text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.id, chosenId))
		.limit(1);
	if (!row) throw new ResumeNotFoundError(chosenId);
	return row;
}

/**
 * The profile rendered to prose for the prompt (or a placeholder). When a track
 * (profileId) is named, read THAT track's active version — under multi-profile
 * several versions are active at once, so a bare active-flag query is arbitrary.
 */
async function activeProfileText(profileId?: string): Promise<string> {
	const [row] = await db
		.select()
		.from(profileVersions)
		.where(
			profileId
				? and(
						eq(profileVersions.profileId, profileId),
						eq(profileVersions.active, true),
					)
				: eq(profileVersions.active, true),
		)
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
export async function tailorPosting(
	jobPostingId: string,
	req: TailorRequest = {},
): Promise<{
	draft: TailoredDraft;
	resumeVersionId: string;
	modelUsed: string;
	promptVersion: string;
}> {
	const posting = await loadPosting(jobPostingId);
	if (!posting)
		throw new Error(`tailorPosting: posting ${jobPostingId} not found`);

	// Base resolution (explicit → track → active) and profile flavor are both
	// deliberate now — no more arbitrary active-row picks under multi-profile.
	const resume = await resolveBase(req);

	const prompt = renderPrompt(TAILOR_POSTING_PROMPT, {
		profile: await activeProfileText(req.profileId),
		jd: renderJd(posting),
		resume: resume.text,
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: TailoredDraftSchema,
		schemaName: "tailored_draft",
		tier: "large",
		// Edits + a keyword-coverage map + an outreach note is verbose; the 3.2
		// review already truncated once at 2048. 6144 gives the tool-call JSON room.
		maxTokens: 6144,
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
 * is what makes the draft reachable from the pipeline. The client passes the base
 * `resumeVersionId` returned by generate, so provenance can't drift if the active
 * resume changed in between (tie-in #2). Throws on unknown posting.
 */
export async function saveTailoredDraft(
	jobPostingId: string,
	draft: TailoredDraft,
	resumeVersionId: string,
): Promise<TailoredDraftRecord> {
	const posting = await loadPosting(jobPostingId);
	if (!posting)
		throw new Error(`saveTailoredDraft: posting ${jobPostingId} not found`);

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
			resumeVersionId,
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
