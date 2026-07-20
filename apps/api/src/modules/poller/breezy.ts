import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// breezy.ts — client for Breezy HR public career portals.
//   GET https://{token}.breezy.hr/json
//   → [ { id, name(title), friendly_id, url, location:{name, is_remote},
//         description } ]   ← a top-level ARRAY, like Lever
//
// Token is a subdomain (like Recruitee). The feed lists published positions;
// `description` (HTML) is usually present but we treat it as optional — a
// posting without text still enters the pipeline and can be scored from its
// title until a richer source (or the bookmarklet) fills it in.
// ---------------------------------------------------------------------------
export const BreezyJobSchema = z.object({
	id: z.string(),
	name: z.string(), // the job title, in Breezy's vocabulary
	friendly_id: z.string().nullish(),
	url: z.string().url().nullish(),
	location: z
		.object({
			name: z.string().nullish(),
			is_remote: z.boolean().nullish(),
		})
		.nullish(),
	description: z.string().nullish(), // HTML
});
export type BreezyJob = z.infer<typeof BreezyJobSchema>;

const BreezyResponseSchema = z.array(BreezyJobSchema);

export async function fetchJobs(token: string): Promise<BreezyJob[]> {
	const sub = encodeURIComponent(token);
	const json = await fetchJson(`https://${sub}.breezy.hr/json`);
	const jobs = BreezyResponseSchema.parse(json);
	// Resolve the URL fallback here, where the token is known (normalize is pure):
	// hosted position pages live at /p/{friendly_id}.
	return jobs.map((j) => ({
		...j,
		url:
			j.url ??
			(j.friendly_id ? `https://${sub}.breezy.hr/p/${j.friendly_id}` : null),
	}));
}
