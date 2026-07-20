import { z } from "zod";

// ---------------------------------------------------------------------------
// Health — the Phase 0 liveness contract. The API returns this shape and the
// web app parses responses against it: one schema, both sides of the wire.
// ---------------------------------------------------------------------------
export const HealthSchema = z.object({
	ok: z.boolean(),
	ts: z.string(), // ISO timestamp
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * @jobber/shared — the single source of truth for data shapes.
 *
 * The pattern here is the spine of the whole codebase: define a Zod schema
 * once, then derive the TypeScript type from it with `z.infer`. Both apps
 * import the *schema* (for runtime validation at the edges) and the *type*
 * (for compile-time checking) from this one line. Change the schema and the
 * compiler flags every place that breaks, on both the API and the web side.
 */

// ---------------------------------------------------------------------------
// Company — one of the ~50 target employers we poll.
// ---------------------------------------------------------------------------
export const AtsTypeSchema = z.enum([
	"greenhouse",
	"lever",
	"ashby",
	"smartrecruiters",
	"workable",
	"recruitee",
	"breezy",
	"bamboohr",
	"manual",
]);
export type AtsType = z.infer<typeof AtsTypeSchema>;

export const CompanySchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	atsType: AtsTypeSchema,
	atsToken: z.string().nullable(), // null for "manual" companies (no pollable API)
	fitGroup: z.number().int().nullable(), // your Group 1–5 tiers
	active: z.boolean(),
});
export type Company = z.infer<typeof CompanySchema>;

// Polling health for the /companies page, derived from the latest poll run:
// "manual" = no pollable API; "failing" = errored in the last run;
// "ok" = polled cleanly; "unknown" = never polled yet.
export const CompanyPollStatusSchema = z.enum([
	"ok",
	"failing",
	"manual",
	"unknown",
]);
export type CompanyPollStatus = z.infer<typeof CompanyPollStatusSchema>;

// One row of the /api/companies list: the company plus computed poll health and
// a count of its currently-open postings.
export const CompanyListItemSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	atsType: AtsTypeSchema,
	fitGroup: z.number().int().nullable(),
	active: z.boolean(),
	pollStatus: CompanyPollStatusSchema,
	openJobs: z.number().int(),
});
export type CompanyListItem = z.infer<typeof CompanyListItemSchema>;

// ---------------------------------------------------------------------------
// JobPosting — a single role, deduped by (companyId, externalId).
// ---------------------------------------------------------------------------
export const JobStatusSchema = z.enum(["open", "closed"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobPostingSchema = z.object({
	id: z.string().uuid(),
	companyId: z.string().uuid(),
	externalId: z.string(), // the ATS's own ID — the dedupe key
	title: z.string(),
	location: z.string().nullable(),
	remote: z.boolean().nullable(),
	compMin: z.number().int().nullable(),
	compMax: z.number().int().nullable(),
	url: z.string().url(),
	status: JobStatusSchema,
	firstSeenAt: z.coerce.date(), // coerce: JSON carries dates as strings; parse → real Date
});
export type JobPosting = z.infer<typeof JobPostingSchema>;

export const JobSourceSchema = z.enum(["poller", "manual", "hn", "rss"]);
export type JobSource = z.infer<typeof JobSourceSchema>;

// One row of the /api/jobs list: a posting joined with its company name and the
// computed prefilter verdict, so the UI can badge/filter without re-deriving it.
export const JobListItemSchema = z.object({
	id: z.string().uuid(),
	companyId: z.string().uuid(),
	companyName: z.string(),
	title: z.string(),
	location: z.string().nullable(),
	remote: z.boolean().nullable(),
	compMin: z.number().int().nullable(),
	compMax: z.number().int().nullable(),
	url: z.string().url(),
	status: JobStatusSchema,
	source: JobSourceSchema,
	candidate: z.boolean(), // did it pass the prefilter?
	firstSeenAt: z.coerce.date(),
	lastSeenAt: z.coerce.date(),
});
export type JobListItem = z.infer<typeof JobListItemSchema>;

// Querystring for GET /api/jobs. Every field optional → no filter on that axis.
// `candidate` is a string on the wire ("true"/"false"); we parse it to a real
// boolean the same footgun-free way we do env booleans (NOT z.coerce.boolean,
// which turns the string "false" into true). See docs/notes/step-1.6.md.
export const JobsQuerySchema = z.object({
	status: JobStatusSchema.optional(),
	companyId: z.string().uuid().optional(),
	candidate: z
		.enum(["true", "false"])
		.transform((v) => v === "true")
		.optional(),
	// Like `candidate`, computed from the location string rather than stored —
	// keep only postings we can place in the US (see isUsLocation).
	usOnly: z
		.enum(["true", "false"])
		.transform((v) => v === "true")
		.optional(),
});
export type JobsQuery = z.infer<typeof JobsQuerySchema>;

// ---------------------------------------------------------------------------
// Sources — the ingestion registry shown on the Settings page. Every way a job
// (or a pipeline signal) can enter the system is one row here: the ATS poller
// today, plus the Phase-4 aggregators/capture/email as "planned". This is the
// single place to answer "what is being pinged or scraped, and is it healthy?".
// ---------------------------------------------------------------------------
export const SourceKindSchema = z.enum([
	"ats", // polled applicant-tracking boards (greenhouse/lever/ashby/…)
	"aggregator", // scraped/parsed feeds (HN Who-is-Hiring, RSS)
	"manual", // human/bookmarklet capture
	"email", // IMAP status ingestion (signals, not postings)
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SourceStatusSchema = z.enum(["active", "planned", "disabled"]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const SourceSummarySchema = z.object({
	key: z.string(), // stable id: "poller" | "hn" | "rss" | "manual" | "imap"
	label: z.string(),
	kind: SourceKindSchema,
	status: SourceStatusSchema,
	description: z.string(),
	// Postings currently in the DB attributed to this source (null for signal-only
	// sources like email that never create postings).
	jobCount: z.number().int().nullable(),
	openJobCount: z.number().int().nullable(),
	// How many endpoints this source pings (e.g. active ATS boards); null if N/A.
	endpoints: z.number().int().nullable(),
	// Poll health from the most recent run, for pinged sources; null otherwise.
	health: z
		.object({ ok: z.number().int(), failing: z.number().int() })
		.nullable(),
	lastRunAt: z.coerce.date().nullable(),
	lastRunNew: z.number().int().nullable(), // postings first seen in that run
	schedule: z.string().nullable(), // human-readable cadence, or null if on-demand
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

// ---------------------------------------------------------------------------
// FitScore — the LLM's verdict on how well a posting matches the candidate.
// This is the *output contract* the scoring model must satisfy: the AI provider
// forces the model to return exactly this shape (Phase 2, step 2.2), and it maps
// onto the fit_scores table in apps/api/src/db/schema.ts. The .describe() strings
// are not decoration — they are converted into the JSON Schema the model sees, so
// they double as field-level instructions to the LLM.
// ---------------------------------------------------------------------------
export const FitScoreSchema = z.object({
	score: z
		.number()
		.min(0)
		.max(10)
		.describe(
			"Overall fit, 0–10. Anchors: 5 = plausible but clear gaps; 8 = strong match worth applying to today; 10 = near-perfect. Decimals allowed.",
		),
	matchPoints: z
		.array(z.string())
		.describe(
			"Concrete reasons this role fits the candidate — skills, domain, seniority, or constraints that line up. 2–5 short bullet strings.",
		),
	gaps: z
		.array(z.string())
		.describe(
			"Concrete mismatches or risks — missing skills, seniority mismatch, unclear remote/comp. 0–5 short bullet strings.",
		),
	credentialGapFlag: z
		.boolean()
		.describe(
			"True if the posting hard-requires a credential the candidate lacks (e.g. CS degree, N years of ML, live coding gate).",
		),
	rationale: z
		.string()
		.describe(
			"2–4 sentence plain-English explanation of the score, for a human triaging quickly.",
		),
	baseCompUsd: z
		.number()
		.nullable()
		.describe(
			"The base salary in USD if the posting discloses one — the LOWER end of a stated range. Null if no base pay is stated. Read it from the posting text; this lets the app filter roles above the candidate's comp ceiling.",
		),
});
export type FitScore = z.infer<typeof FitScoreSchema>;

// Your thumbs-up/down on a score, plus an optional note. Body of
// POST /api/scores/:id/feedback (step 2.4). This signal feeds profile revisions
// in Phase 3 — a down-voted 8 is exactly the kind of miscalibration to learn from.
export const ScoreVerdictSchema = z.enum(["up", "down"]);
export type ScoreVerdict = z.infer<typeof ScoreVerdictSchema>;

export const ScoreFeedbackSchema = z.object({
	verdict: ScoreVerdictSchema,
	note: z.string().optional(),
});
export type ScoreFeedback = z.infer<typeof ScoreFeedbackSchema>;

// One row of the /api/triage list: a fit score joined with its posting and
// company. This is the shape the triage page renders — a scored posting worth
// reviewing (open, not yet applied, not dismissed), sorted best-first by the API.
export const TriageItemSchema = z.object({
	scoreId: z.string().uuid(),
	jobPostingId: z.string().uuid(),
	companyId: z.string().uuid(),
	companyName: z.string(),
	title: z.string(),
	url: z.string().url(),
	location: z.string().nullable(),
	remote: z.boolean().nullable(),
	compMin: z.number().int().nullable(),
	compMax: z.number().int().nullable(),
	// The scorer's read of the base comp from the posting text (the ATS feeds
	// rarely disclose it structurally), used to render comp and enforce the ceiling.
	baseCompUsd: z.number().nullable(),
	score: z.number(),
	matchPoints: z.array(z.string()),
	gaps: z.array(z.string()),
	credentialGapFlag: z.boolean(),
	rationale: z.string(),
	feedback: ScoreVerdictSchema.nullable(),
	createdAt: z.coerce.date(),
});
export type TriageItem = z.infer<typeof TriageItemSchema>;

// GET /api/stats/ai-spend — the running cost story, summed for the current month
// from ai_runs. Rendered as a small stat on the triage page (step 2.5).
export const AiSpendSchema = z.object({
	month: z.string(), // "YYYY-MM"
	totalUsd: z.number(),
	runs: z.number().int(),
});
export type AiSpend = z.infer<typeof AiSpendSchema>;

// ---------------------------------------------------------------------------
// IdealJobProfile — the versioned rubric the scorer grades against (Phase 3,
// step 3.1). This is BOTH the AI "propose a profile" output contract and the
// save-a-profile request body; a saved version splits into the profile_versions
// table (northStar → its column, {hardFilters, criteria} → the rubric jsonb).
// ---------------------------------------------------------------------------
export const HardFiltersSchema = z.object({
	compFloor: z
		.number()
		.int()
		.nullable()
		.describe("Minimum acceptable base comp in USD, or null if no hard floor."),
	compCeiling: z
		.number()
		.int()
		.nullable()
		.describe(
			"Maximum base comp in USD worth pursuing. Roles whose disclosed base floor is above this are likely too senior / a poor use of time and are filtered out of scoring and triage. Null = no ceiling.",
		),
	locationRule: z
		.string()
		.describe('Plain-English location constraint, e.g. "Remote (US) only".'),
	remoteRequired: z
		.boolean()
		.describe("True if on-site/hybrid is a dealbreaker."),
});
export type HardFilters = z.infer<typeof HardFiltersSchema>;

export const ProfileCriterionSchema = z.object({
	name: z.string().describe("Short label, e.g. 'Applied-AI work'."),
	weight: z
		.number()
		.int()
		.min(1)
		.max(5)
		.describe("How much this matters, 1 (minor) – 5 (decisive)."),
	description: z
		.string()
		.describe("What a strong match on this criterion looks like."),
});
export type ProfileCriterion = z.infer<typeof ProfileCriterionSchema>;

export const IdealJobProfileSchema = z.object({
	northStar: z
		.string()
		.describe("One paragraph: the role this candidate is actually aiming for."),
	hardFilters: HardFiltersSchema,
	criteria: z
		.array(ProfileCriterionSchema)
		.min(1)
		.describe("The weighted grading key — 3–6 criteria works well."),
});
export type IdealJobProfile = z.infer<typeof IdealJobProfileSchema>;

// A saved profile version as returned by GET /api/profile (the profile content
// plus its version metadata). null when no profile has been saved yet.
export const ProfileVersionSchema = IdealJobProfileSchema.extend({
	id: z.string().uuid(),
	version: z.number().int(),
	active: z.boolean(),
	createdAt: z.coerce.date(),
});
export type ProfileVersion = z.infer<typeof ProfileVersionSchema>;

// POST /api/profile/propose body — optional free-text notes ("what I'm looking
// for") the AI folds in alongside resume + application history.
export const ProfileProposeSchema = z.object({
	notes: z.string().optional(),
});
export type ProfilePropose = z.infer<typeof ProfileProposeSchema>;

// ---------------------------------------------------------------------------
// Resume versions (Phase 3, step 3.2). An uploaded resume becomes a versioned
// row (extracted text + metadata); one is "active" and feeds the scorer and the
// profile-proposer. The list returns metadata only; the detail adds the text.
// ---------------------------------------------------------------------------
// "base" = an uploaded resume the scorer reads; "tailored" = a per-posting
// variant assembled from a base + reviewed edits (tailor-v2). Only bases active.
export const ResumeKindSchema = z.enum(["base", "tailored"]);
export type ResumeKind = z.infer<typeof ResumeKindSchema>;

export const ResumeVersionSchema = z.object({
	id: z.string().uuid(),
	label: z.string(),
	active: z.boolean(),
	kind: ResumeKindSchema,
	// Set on tailored rows: the base it was derived from and the posting it targets.
	parentId: z.string().uuid().nullable(),
	jobPostingId: z.string().uuid().nullable(),
	charCount: z.number().int(),
	createdAt: z.coerce.date(),
});
export type ResumeVersion = z.infer<typeof ResumeVersionSchema>;

export const ResumeDetailSchema = ResumeVersionSchema.extend({
	extractedText: z.string(),
});
export type ResumeDetail = z.infer<typeof ResumeDetailSchema>;

// The AI resume-review output contract (large tier). Draft feedback only — the
// human decides what to change (house rule: AI drafts, human finishes).
export const ResumeReviewSchema = z.object({
	summary: z
		.string()
		.describe(
			"2–3 sentence overall read: how strong, and for what kind of role.",
		),
	strengths: z
		.array(z.string())
		.describe("What's working — concrete, cite the resume."),
	weaknesses: z
		.array(z.string())
		.describe("What's weak or missing, against the target profile."),
	sectionSuggestions: z
		.array(
			z.object({
				section: z.string().describe("e.g. 'Summary', 'Experience — Acme'."),
				suggestion: z.string().describe("A specific, actionable rewrite idea."),
			}),
		)
		.describe("Per-section, actionable edits."),
	atsFlags: z
		.array(z.string())
		.describe(
			"Formatting/keyword issues that could trip an applicant-tracking system (tables, columns, missing keywords, non-standard headings).",
		),
});
export type ResumeReview = z.infer<typeof ResumeReviewSchema>;

// ---------------------------------------------------------------------------
// Tailor-to-posting (Phase 3, step 3.2b). From a high-scoring job, the AI drafts
// concrete resume edits + an outreach note, tuned to THAT posting. This is the
// AI output contract (forced-tool-shaped): the model returns a summary, a set of
// before/after edits (each diffable in the UI), and a draft outreach note. Per
// the house rule it's a DRAFT — the human finishes it, nothing is auto-sent.
// ---------------------------------------------------------------------------
export const TailorEditSchema = z.object({
	section: z
		.string()
		.describe(
			"Which resume area this edit touches, e.g. 'Summary', 'Experience — Acme'.",
		),
	original: z
		.string()
		.describe(
			"The existing resume text to change, quoted verbatim so the UI can diff it. Empty string if this is brand-new content to add.",
		),
	tailored: z
		.string()
		.describe(
			"The proposed replacement text, rewritten to match this posting.",
		),
	rationale: z
		.string()
		.describe("One sentence: why this change helps for THIS role."),
});
export type TailorEdit = z.infer<typeof TailorEditSchema>;

// One entry in the keyword-coverage map (tailor-v2). The model pulls the most
// screening-relevant terms VERBATIM from the ad and marks whether the resume
// already truthfully supports each — the honest-gap guarantee made structural.
export const KeywordHitSchema = z.object({
	keyword: z.string().describe("Verbatim term/phrase from the job ad."),
	covered: z
		.boolean()
		.describe("Does the resume already truthfully support it?"),
	note: z
		.string()
		.describe(
			"If covered: where in the resume. If not: how to honestly address it — or 'genuine gap, do not fake'.",
		),
});
export type KeywordHit = z.infer<typeof KeywordHitSchema>;

// The AI output contract for a tailoring run (large tier).
export const TailoredDraftSchema = z.object({
	summary: z
		.string()
		.describe(
			"2–3 sentences: the angle to take for this posting and the biggest lever to pull.",
		),
	edits: z
		.array(TailorEditSchema)
		.describe(
			"Concrete before/after resume edits — 3–6 high-impact ones, not a full rewrite.",
		),
	keywords: z
		.array(KeywordHitSchema)
		.describe(
			"8–15 screening-relevant terms pulled verbatim from the ad, each marked covered/not against the resume.",
		),
	outreachNote: z
		.string()
		.describe(
			"A short, specific draft outreach note (120–180 words) the human can edit and send by hand — never auto-sent.",
		),
});
export type TailoredDraft = z.infer<typeof TailoredDraftSchema>;

// A saved tailored draft as stored/returned by the API: the draft content plus
// the row metadata (which posting/application/resume it belongs to, provenance).
export const TailoredDraftRecordSchema = TailoredDraftSchema.extend({
	id: z.string().uuid(),
	jobPostingId: z.string().uuid(),
	applicationId: z.string().uuid().nullable(), // linked if an application exists
	resumeVersionId: z.string().uuid().nullable(), // the resume that was tailored
	modelUsed: z.string(),
	promptVersion: z.string(),
	createdAt: z.coerce.date(),
});
export type TailoredDraftRecord = z.infer<typeof TailoredDraftRecordSchema>;

// POST /api/postings/:id/tailor body (tailor-v2). Both optional — the service
// resolves the base deterministically: explicit resumeVersionId → the track's
// (profileId's) own resume → the globally active resume.
export const TailorRequestSchema = z.object({
	resumeVersionId: z.string().uuid().optional(),
	profileId: z.string().uuid().optional(),
});
export type TailorRequest = z.infer<typeof TailorRequestSchema>;

// POST /api/postings/:id/tailor/resume body (tailor-v2, step T3). Assembles the
// reviewed draft's edits onto the base into a full tailored resume_versions row.
// No AI — pure, deterministic replacement, so it works offline.
export const TailorAssembleRequestSchema = z.object({
	draft: TailoredDraftSchema,
	resumeVersionId: z.string().uuid(), // the base the edits quote from
	label: z.string().optional(), // defaults to "<Company> — <Title>"
});
export type TailorAssembleRequest = z.infer<typeof TailorAssembleRequestSchema>;

// The assemble result: the new tailored resume version, plus any edits whose
// `original` couldn't be found verbatim in the base — surfaced, never dropped, so
// the human can place them by hand.
export const TailorAssembleResultSchema = z.object({
	resume: ResumeDetailSchema,
	failed: z.array(TailorEditSchema),
});
export type TailorAssembleResult = z.infer<typeof TailorAssembleResultSchema>;

// ---------------------------------------------------------------------------
// Application — your pipeline. The event log is the truth; `status` is a fast
// denormalized mirror of it (see the tracker module + docs/notes/step-1.6.md).
// These enums mirror the DB enums in apps/api/src/db/schema.ts — schema.ts owns
// the column definitions, this owns the wire contract; keep them in step.
// ---------------------------------------------------------------------------
export const ApplicationChannelSchema = z.enum([
	"ats",
	"careers_email",
	"hn",
	"wellfound",
	"referral",
	"other", // catch-all: job board / unknown channel (e.g. imported tracker rows)
]);
export type ApplicationChannel = z.infer<typeof ApplicationChannelSchema>;

export const ApplicationStatusSchema = z.enum([
	"applied",
	"screen",
	"interview",
	"offer",
	"rejected",
	"ghosted",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const ApplicationEventTypeSchema = z.enum([
	"applied",
	"auto_ack",
	"rejection",
	"screen_invite",
	"note",
]);
export type ApplicationEventType = z.infer<typeof ApplicationEventTypeSchema>;

// One entry in an application's timeline.
export const ApplicationEventSchema = z.object({
	id: z.string().uuid(),
	applicationId: z.string().uuid(),
	type: ApplicationEventTypeSchema,
	occurredAt: z.coerce.date(),
	detail: z.string().nullable(),
});
export type ApplicationEvent = z.infer<typeof ApplicationEventSchema>;

// A full application row as returned by the API.
export const ApplicationSchema = z.object({
	id: z.string().uuid(),
	jobPostingId: z.string().uuid().nullable(),
	companyId: z.string().uuid().nullable(),
	companyName: z.string(),
	roleTitle: z.string(),
	channel: ApplicationChannelSchema,
	appliedAt: z.coerce.date(),
	status: ApplicationStatusSchema,
	resumeVersionId: z.string().uuid().nullable(),
	notes: z.string().nullable(),
});
export type Application = z.infer<typeof ApplicationSchema>;

// The list/detail shape: an application plus its ordered event timeline.
export const ApplicationWithEventsSchema = ApplicationSchema.extend({
	events: z.array(ApplicationEventSchema),
});
export type ApplicationWithEvents = z.infer<typeof ApplicationWithEventsSchema>;

// POST /api/applications body. Only the four facts you always know are required;
// links and timestamps are optional (appliedAt defaults to now server-side).
export const ApplicationCreateSchema = z.object({
	companyName: z.string().min(1),
	roleTitle: z.string().min(1),
	channel: ApplicationChannelSchema,
	appliedAt: z.coerce.date().optional(),
	status: ApplicationStatusSchema.optional(),
	notes: z.string().optional(),
	jobPostingId: z.string().uuid().optional(),
	companyId: z.string().uuid().optional(),
	resumeVersionId: z.string().uuid().optional(),
});
export type ApplicationCreate = z.infer<typeof ApplicationCreateSchema>;

// PATCH /api/applications/:id/status body.
export const ApplicationStatusUpdateSchema = z.object({
	status: ApplicationStatusSchema,
	detail: z.string().optional(), // free-text note stored on the event
});
export type ApplicationStatusUpdate = z.infer<
	typeof ApplicationStatusUpdateSchema
>;
