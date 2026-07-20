import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// workable.ts — client for the Workable public jobs widget API.
//   GET https://apply.workable.com/api/v1/widget/accounts/{token}?details=true
//   → { name, jobs: [ { title, shortcode, url, application_url,
//                       telecommuting, city, state, country, description } ] }
//
// This is the endpoint behind Workable's embeddable jobs widget: public, no
// auth, and with ?details=true it inlines the HTML description — one request
// per board, like Greenhouse. `shortcode` is the stable external id;
// `telecommuting` is their remote flag.
// ---------------------------------------------------------------------------
export const WorkableJobSchema = z.object({
	shortcode: z.string(),
	title: z.string(),
	url: z.string().url().nullish(), // hosted job page
	application_url: z.string().url().nullish(), // direct apply form
	telecommuting: z.boolean().nullish(),
	city: z.string().nullish(),
	state: z.string().nullish(),
	country: z.string().nullish(),
	description: z.string().nullish(), // HTML, present with ?details=true
});
export type WorkableJob = z.infer<typeof WorkableJobSchema>;

const WorkableResponseSchema = z.object({
	jobs: z.array(WorkableJobSchema),
});

export async function fetchJobs(token: string): Promise<WorkableJob[]> {
	const json = await fetchJson(
		`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`,
	);
	return WorkableResponseSchema.parse(json).jobs;
}
