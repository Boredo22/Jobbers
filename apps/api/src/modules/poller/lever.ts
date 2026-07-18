import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// lever.ts — client for Lever public postings.
//   GET https://api.lever.co/v0/postings/{token}?mode=json
//   → [ { id, text(title), hostedUrl, categories:{location}, workplaceType,
//         descriptionPlain, description(HTML) } ]   ← a top-level ARRAY
//
// Unlike Greenhouse/Ashby, Lever returns the array directly (not wrapped in an
// object), which is why the response schema is z.array(...) not z.object(...).
// Lever helpfully provides descriptionPlain, so we rarely strip HTML here.
// ---------------------------------------------------------------------------
export const LeverJobSchema = z.object({
	id: z.string(),
	text: z.string(), // the job title, in Lever's vocabulary
	hostedUrl: z.string().url(),
	categories: z.object({ location: z.string().nullish() }).nullish(),
	workplaceType: z.string().nullish(), // "remote" | "on-site" | "hybrid"
	descriptionPlain: z.string().nullish(),
	description: z.string().nullish(), // HTML fallback if descriptionPlain absent
});
export type LeverJob = z.infer<typeof LeverJobSchema>;

const LeverResponseSchema = z.array(LeverJobSchema);

export async function fetchJobs(token: string): Promise<LeverJob[]> {
	const json = await fetchJson(
		`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
	);
	return LeverResponseSchema.parse(json);
}
