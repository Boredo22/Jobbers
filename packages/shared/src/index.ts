import { z } from "zod";

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
