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
export const AtsTypeSchema = z.enum(["greenhouse", "lever", "ashby", "manual"]);
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
});
export type JobsQuery = z.infer<typeof JobsQuerySchema>;

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
