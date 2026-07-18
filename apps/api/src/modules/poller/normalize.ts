import { createHash } from "node:crypto";
import type { AshbyJob } from "./ashby";
import type { GreenhouseJob } from "./greenhouse";
import type { LeverJob } from "./lever";

// ---------------------------------------------------------------------------
// normalize.ts — turn each platform's shape into ONE common shape.
//
// The three ATS APIs disagree on everything: Greenhouse calls the title
// `title`, Lever calls it `text`; ids are numbers vs strings; descriptions
// arrive as HTML or plain text. Downstream code (the upsert in step 1.4, the
// scorer in Phase 2) should never care about those differences — so every
// posting funnels through here into `NormalizedPosting`.
//
// These functions are PURE (no network, no clock, no DB): raw postings in,
// normalized postings out. That's what makes them unit-testable against fixture
// JSON (convention §9.3) — the checkpoint of this step is really "do these
// mappers produce sane output?".
// ---------------------------------------------------------------------------

/**
 * The common shape, ≈ the shared JobPosting minus DB-generated fields
 * (id/companyId/status/firstSeenAt) plus the two poller-computed fields
 * (description text + contentHash). The poll runner adds companyId and lets the
 * DB fill the rest.
 */
export type NormalizedPosting = {
	externalId: string;
	title: string;
	url: string;
	location: string | null;
	remote: boolean | null;
	compMin: number | null;
	compMax: number | null;
	description: string | null;
	contentHash: string;
};

/**
 * Pragmatic HTML → text. Decodes the handful of entities that actually show up,
 * drops script/style, strips tags, collapses whitespace. Not a full HTML parser
 * (we don't need one): the LLM scorer just wants readable text.
 */
export function stripHtml(input: string): string {
	const decoded = input
		.replace(/&nbsp;/gi, " ")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&"); // ampersand last, so &amp;lt; degrades gracefully
	return decoded
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The idempotency fingerprint. Hash title+description so an *edited* posting
 * (same external id, changed text) is detectable in step 1.4 without diffing
 * every field. sha256 hex is overkill-safe and cheap.
 */
export function contentHashOf(
	title: string,
	description: string | null,
): string {
	return createHash("sha256")
		.update(`${title}\n${description ?? ""}`)
		.digest("hex");
}

/** No structured location flag? Infer remote from the location text. */
function detectRemote(location: string | null): boolean | null {
	if (!location) return null;
	return /remote/i.test(location);
}

// NOTE on comp: all three normalizers leave compMin/compMax null for now.
// Salary is disclosed inconsistently and parsing it (regex vs LLM) is an
// explicit Phase 2 concern (plan §9). The columns exist; we fill them later.

export function normalizeGreenhouse(
	jobs: GreenhouseJob[],
): NormalizedPosting[] {
	return jobs.map((j) => {
		const description = j.content ? stripHtml(j.content) || null : null;
		const location = j.location?.name ?? null;
		return {
			externalId: String(j.id),
			title: j.title,
			url: j.absolute_url,
			location,
			remote: detectRemote(location),
			compMin: null,
			compMax: null,
			description,
			contentHash: contentHashOf(j.title, description),
		};
	});
}

export function normalizeLever(jobs: LeverJob[]): NormalizedPosting[] {
	return jobs.map((j) => {
		const description =
			j.descriptionPlain ??
			(j.description ? stripHtml(j.description) || null : null);
		const location = j.categories?.location ?? null;
		const remote = j.workplaceType
			? j.workplaceType.toLowerCase() === "remote"
			: detectRemote(location);
		return {
			externalId: j.id,
			title: j.text,
			url: j.hostedUrl,
			location,
			remote,
			compMin: null,
			compMax: null,
			description,
			contentHash: contentHashOf(j.text, description),
		};
	});
}

export function normalizeAshby(jobs: AshbyJob[]): NormalizedPosting[] {
	return jobs
		.map((j) => {
			const description =
				j.descriptionPlain ??
				(j.descriptionHtml ? stripHtml(j.descriptionHtml) || null : null);
			const location = j.location ?? null;
			return {
				externalId: j.id,
				title: j.title,
				url: j.jobUrl ?? j.applyUrl ?? "",
				location,
				remote: j.isRemote ?? detectRemote(location),
				compMin: null,
				compMax: null,
				description,
				contentHash: contentHashOf(j.title, description),
			};
		})
		.filter((p) => p.url !== ""); // drop the (rare) posting with no usable URL
}
