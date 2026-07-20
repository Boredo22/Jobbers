import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// recruitee.ts — client for Recruitee public career-site offers.
//   GET https://{token}.recruitee.com/api/offers/
//   → { offers: [ { id, title, careers_url, location, remote,
//                   description, requirements } ] }
//
// Unlike the other boards, the token is a SUBDOMAIN, not a path segment. The
// endpoint only returns published offers, with the description split across
// two HTML fields (`description` + `requirements`) that we stitch back
// together in the normalizer.
// ---------------------------------------------------------------------------
export const RecruiteeJobSchema = z.object({
	id: z.number(), // numeric, like Greenhouse; stringified in normalize
	title: z.string(),
	slug: z.string().nullish(),
	careers_url: z.string().url().nullish(),
	location: z.string().nullish(),
	city: z.string().nullish(),
	country: z.string().nullish(),
	remote: z.boolean().nullish(),
	description: z.string().nullish(), // HTML
	requirements: z.string().nullish(), // HTML
});
export type RecruiteeJob = z.infer<typeof RecruiteeJobSchema>;

const RecruiteeResponseSchema = z.object({
	offers: z.array(RecruiteeJobSchema),
});

export async function fetchJobs(token: string): Promise<RecruiteeJob[]> {
	const sub = encodeURIComponent(token);
	const json = await fetchJson(`https://${sub}.recruitee.com/api/offers/`);
	const offers = RecruiteeResponseSchema.parse(json).offers;
	// The normalizer is pure and can't know the token, so resolve the URL
	// fallback (careers_url missing → build from slug) here at the client.
	return offers.map((o) => ({
		...o,
		careers_url:
			o.careers_url ??
			(o.slug ? `https://${sub}.recruitee.com/o/${o.slug}` : null),
	}));
}
