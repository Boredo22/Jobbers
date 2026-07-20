import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_RESUME_PROMPT, renderPrompt } from "@jobber/ai";
import {
	type ResumeDetail,
	type ResumeReview,
	ResumeReviewSchema,
	type ResumeVersion,
} from "@jobber/shared";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { resumeVersions } from "../../db/schema";
import { createProvider, logAiRun } from "../../lib/ai";
import { getActiveProfile } from "../profile/service";

// ---------------------------------------------------------------------------
// resume/service.ts — resume upload, versioning, and AI review (Phase 3, 3.2).
//
// An uploaded file is turned into TEXT (pdf/docx/txt), stored as a versioned row,
// and one version is active. The active resume's text is what the scorer and the
// profile-proposer read — so uploading a real resume immediately upgrades the
// {{resume}} placeholder they were falling back on.
// ---------------------------------------------------------------------------

// Uploaded files land on disk beside the api's other data/ files (gitignored).
// Resolve from THIS module's URL so it's cwd-independent, like the seed scripts.
const RESUMES_DIR = fileURLToPath(
	new URL("../../../data/resumes/", import.meta.url),
);

/**
 * Extract plain text from an uploaded resume. The LLM wants text, not layout —
 * so a PDF/DOCX gets flattened here at the edge. Throws on an unsupported type or
 * an empty extraction (a scanned-image PDF yields no text — better a loud error
 * than a blank resume silently feeding the scorer).
 */
export async function extractText(
	filename: string,
	buffer: Buffer,
): Promise<string> {
	const ext = extname(filename).toLowerCase();
	let text: string;

	if (ext === ".pdf") {
		// pdf-parse v2 is class-based: construct with the bytes, then getText().
		const { PDFParse } = await import("pdf-parse");
		const parser = new PDFParse({ data: buffer });
		try {
			text = (await parser.getText()).text;
		} finally {
			await parser.destroy();
		}
	} else if (ext === ".docx") {
		const mammoth = (await import("mammoth")).default;
		text = (await mammoth.extractRawText({ buffer })).value;
	} else if (ext === ".txt" || ext === ".md") {
		text = buffer.toString("utf8");
	} else {
		throw new Error(
			`Unsupported resume type "${ext}" — use PDF, DOCX, or TXT.`,
		);
	}

	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new Error(
			"No text could be extracted (is this a scanned image? OCR isn't supported).",
		);
	}
	return trimmed;
}

function toResumeVersion(
	row: Pick<
		typeof resumeVersions.$inferSelect,
		"id" | "label" | "active" | "createdAt"
	>,
	charCount: number,
): ResumeVersion {
	return {
		id: row.id,
		label: row.label,
		active: row.active,
		charCount,
		createdAt: row.createdAt,
	};
}

/**
 * Store an uploaded resume: write the original file to disk, extract its text,
 * and insert a new version — made active (deactivating others) in one
 * transaction, so uploading immediately makes it the resume everything reads.
 */
export async function createResumeVersion(
	filename: string,
	buffer: Buffer,
): Promise<ResumeVersion> {
	const text = await extractText(filename, buffer);

	// Keep the original file too (audit / future re-extraction). Name it by a
	// random id so two "resume.pdf" uploads can't collide.
	await mkdir(RESUMES_DIR, { recursive: true });
	const storedPath = `${RESUMES_DIR}${randomUUID()}${extname(filename)}`;
	await writeFile(storedPath, buffer);

	return db.transaction(async (tx) => {
		await tx
			.update(resumeVersions)
			.set({ active: false })
			.where(eq(resumeVersions.active, true));

		const [row] = await tx
			.insert(resumeVersions)
			.values({
				label: filename,
				filePath: storedPath,
				extractedText: text,
				active: true,
			})
			.returning();
		if (!row) throw new Error("createResumeVersion: insert returned no row");
		return toResumeVersion(row, text.length);
	});
}

/** All resume versions (metadata only), newest first. */
export async function listResumes(): Promise<ResumeVersion[]> {
	const rows = await db
		.select({
			id: resumeVersions.id,
			label: resumeVersions.label,
			active: resumeVersions.active,
			createdAt: resumeVersions.createdAt,
			charCount: sql<number>`length(${resumeVersions.extractedText})::int`,
		})
		.from(resumeVersions)
		.orderBy(desc(resumeVersions.createdAt));
	return rows.map((r) => toResumeVersion(r, r.charCount));
}

/** One version with its extracted text, or null if the id is unknown. */
export async function getResumeDetail(
	id: string,
): Promise<ResumeDetail | null> {
	const [row] = await db
		.select()
		.from(resumeVersions)
		.where(eq(resumeVersions.id, id))
		.limit(1);
	if (!row) return null;
	return {
		...toResumeVersion(row, row.extractedText.length),
		extractedText: row.extractedText,
	};
}

/** Make one version active (deactivating the rest). False if the id is unknown. */
export async function setActiveResume(id: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [exists] = await tx
			.select({ id: resumeVersions.id })
			.from(resumeVersions)
			.where(eq(resumeVersions.id, id))
			.limit(1);
		if (!exists) return false;

		await tx
			.update(resumeVersions)
			.set({ active: false })
			.where(eq(resumeVersions.active, true));
		await tx
			.update(resumeVersions)
			.set({ active: true })
			.where(eq(resumeVersions.id, id));
		return true;
	});
}

/** Build the active profile as prose for the review prompt (or a placeholder). */
async function activeProfileText(): Promise<string> {
	const profile = await getActiveProfile();
	if (!profile) return "(No ideal-job profile defined yet.)";
	const criteria = profile.criteria
		.map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`)
		.join("\n");
	return `${profile.northStar}\n\nWhat matters, and how much:\n${criteria}`;
}

/**
 * AI review of a resume against the active profile (large tier). Returns draft
 * feedback — the human decides what to change. Throws if the id is unknown.
 */
export async function reviewResume(id: string): Promise<ResumeReview> {
	const detail = await getResumeDetail(id);
	if (!detail) throw new Error(`reviewResume: resume ${id} not found`);

	const prompt = renderPrompt(REVIEW_RESUME_PROMPT, {
		resume: detail.extractedText,
		profile: await activeProfileText(),
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: ResumeReviewSchema,
		schemaName: "resume_review",
		tier: "large",
		// A full review (summary + four bullet arrays) is verbose; 2048 truncated
		// the tool-call JSON mid-array, failing validation. 4096 gives it room.
		maxTokens: 4096,
	});
	await logAiRun("resume_review", result);
	return result.data;
}
