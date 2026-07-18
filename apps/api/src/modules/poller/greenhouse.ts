import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// greenhouse.ts — client for Greenhouse public job boards.
//   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   → { jobs: [ { id, title, absolute_url, location, content(HTML) } ] }
//
// The schema is *lenient on purpose*: we model only the fields we use and mark
// anything that might be absent as nullish. Zod strips unknown keys by default
// (it does NOT error on them), so Greenhouse adding a new field never breaks
// polling — exactly the tolerance we want at an external boundary.
// ---------------------------------------------------------------------------
export const GreenhouseJobSchema = z.object({
	id: z.number(), // Greenhouse ids are numbers; we stringify them in normalize
	title: z.string(),
	absolute_url: z.string().url(),
	location: z.object({ name: z.string() }).nullish(),
	content: z.string().nullish(), // HTML, entity-encoded; only present with ?content=true
});
export type GreenhouseJob = z.infer<typeof GreenhouseJobSchema>;

const GreenhouseResponseSchema = z.object({
	jobs: z.array(GreenhouseJobSchema),
});

export async function fetchJobs(token: string): Promise<GreenhouseJob[]> {
	const json = await fetchJson(
		`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
	);
	// The Zod boundary: an unexpected response shape throws here, loudly, rather
	// than surfacing as `undefined` deep in the normalizer.
	return GreenhouseResponseSchema.parse(json).jobs;
}
