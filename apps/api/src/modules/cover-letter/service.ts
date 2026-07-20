import { COVER_LETTER_PROMPT, renderPrompt } from "@jobber/ai";
import {
	type CoverLetterDraft,
	CoverLetterDraftSchema,
	type CoverLetterRequest,
} from "@jobber/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { resumeVersions } from "../../db/schema";
import { createProvider, logAiRun } from "../../lib/ai";

// ---------------------------------------------------------------------------
// cover-letter/service.ts — one-paragraph cover letter for the Chrome
// extension companion.
//
// Unlike tailor (which starts from a posting row in OUR database), the input
// here is raw text the extension scraped off whatever job page the owner is
// looking at — the posting may not exist in the DB at all. So the service
// takes the text as-is, grounds the letter in the active resume, and returns
// a draft. Nothing is persisted: the human edits it in the sidebar and the
// letter leaves the machine by their hand (AI drafts, human finishes).
// ---------------------------------------------------------------------------

const RESUME_FALLBACK =
	"(No resume on file — write only from the posting, make no experience claims.)";

/** The active resume's extracted text, or a loud placeholder. */
async function activeResumeText(): Promise<string> {
	const [row] = await db
		.select({ text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.active, true))
		.limit(1);
	return row?.text ?? RESUME_FALLBACK;
}

/**
 * Draft a cover letter from scanned job-page text. Large tier: this is a
 * rare, user-facing document, not bulk work. The model does the date math for
 * layout only — the date string itself is rendered here so it's always
 * today's real date, never a hallucinated one.
 */
export async function draftCoverLetter(
	req: CoverLetterRequest,
): Promise<{ draft: CoverLetterDraft; model: string }> {
	const resume = await activeResumeText();

	// "July 20, 2026" — the standard US business-letter date line.
	const date = new Date().toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});

	// The tab title often carries "Role – Company | Board" when the page body
	// scan is noisy; give the model both, clearly labeled.
	const jd = req.pageTitle
		? `Page title: ${req.pageTitle}\n\n${req.jobText}`
		: req.jobText;

	const prompt = renderPrompt(COVER_LETTER_PROMPT, {
		jd,
		resume,
		candidate: req.candidateName,
		date,
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: CoverLetterDraftSchema,
		schemaName: "cover_letter",
		tier: "large",
		maxTokens: 1024,
	});
	await logAiRun("cover_letter", result);
	return { draft: result.data, model: result.model };
}
