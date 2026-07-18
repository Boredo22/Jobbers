import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// ashby.ts — client for Ashby public job boards.
//   GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
//   → { jobs: [ { id, title, location, isRemote, descriptionPlain,
//                 descriptionHtml, jobUrl, applyUrl, compensation } ] }
//
// We pass includeCompensation=true so structured pay is present in the payload
// for later (comp parsing itself is deferred to Phase 2 — see normalize.ts).
// Ashby is the friendliest of the three: it gives an explicit isRemote boolean
// and a plain-text description.
// ---------------------------------------------------------------------------
export const AshbyJobSchema = z.object({
	id: z.string(),
	title: z.string(),
	location: z.string().nullish(),
	isRemote: z.boolean().nullish(),
	descriptionPlain: z.string().nullish(),
	descriptionHtml: z.string().nullish(),
	jobUrl: z.string().url().nullish(),
	applyUrl: z.string().url().nullish(),
});
export type AshbyJob = z.infer<typeof AshbyJobSchema>;

const AshbyResponseSchema = z.object({
	jobs: z.array(AshbyJobSchema),
});

export async function fetchJobs(token: string): Promise<AshbyJob[]> {
	const json = await fetchJson(
		`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
	);
	return AshbyResponseSchema.parse(json).jobs;
}
