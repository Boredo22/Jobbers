import pLimit from "p-limit";
import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// smartrecruiters.ts — client for the SmartRecruiters public Posting API.
//   GET https://api.smartrecruiters.com/v1/companies/{token}/postings
//   → { totalFound, offset, limit, content: [ { id, name, location } ] }
//
// Two quirks vs. the boards we already poll:
//   1. The list endpoint is PAGINATED (offset/limit, max 100 per page), so we
//      loop until we've seen totalFound.
//   2. The list has NO description — that lives on the per-posting detail
//      endpoint (…/postings/{id}) inside `jobAd.sections`. We fetch details
//      with a small concurrency cap and merge them onto the list rows. A
//      failed detail fetch degrades to a null description rather than failing
//      the whole company (descriptions are nullable all the way down).
// ---------------------------------------------------------------------------

const LocationSchema = z
	.object({
		city: z.string().nullish(),
		region: z.string().nullish(),
		country: z.string().nullish(),
		remote: z.boolean().nullish(),
	})
	.nullish();

const ListItemSchema = z.object({
	id: z.string(),
	name: z.string(), // the job title, in SmartRecruiters' vocabulary
	location: LocationSchema,
});

const ListResponseSchema = z.object({
	totalFound: z.number(),
	content: z.array(ListItemSchema),
});

// jobAd.sections is a map of { title, text(HTML) } blocks (companyDescription,
// jobDescription, qualifications, …). We keep it open-ended via z.record.
const DetailSchema = z.object({
	applyUrl: z.string().url().nullish(),
	jobAd: z
		.object({
			sections: z
				.record(
					z.string(),
					z.object({
						title: z.string().nullish(),
						text: z.string().nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

export type SmartRecruitersJob = z.infer<typeof ListItemSchema> & {
	applyUrl: string | null;
	/** HTML blocks from jobAd.sections, in order; null when detail fetch failed. */
	sectionsHtml: string[] | null;
	/** Public fallback URL, built from the board token + posting id. */
	fallbackUrl: string;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 10; // safety valve — 1000 postings is far beyond our boards
const DETAIL_CONCURRENCY = 5;

export async function fetchJobs(token: string): Promise<SmartRecruitersJob[]> {
	const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;

	const items: z.infer<typeof ListItemSchema>[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const json = await fetchJson(
			`${base}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
		);
		const parsed = ListResponseSchema.parse(json);
		items.push(...parsed.content);
		if (items.length >= parsed.totalFound || parsed.content.length === 0) {
			break;
		}
	}

	const limit = pLimit(DETAIL_CONCURRENCY);
	return Promise.all(
		items.map((item) =>
			limit(async (): Promise<SmartRecruitersJob> => {
				const fallbackUrl = `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(item.id)}`;
				try {
					const detail = DetailSchema.parse(
						await fetchJson(`${base}/${encodeURIComponent(item.id)}`),
					);
					const sections = detail.jobAd?.sections ?? {};
					const sectionsHtml = Object.values(sections)
						.map((s) => s.text ?? "")
						.filter((t) => t !== "");
					return {
						...item,
						applyUrl: detail.applyUrl ?? null,
						sectionsHtml,
						fallbackUrl,
					};
				} catch {
					// Detail is enrichment, not identity: keep the posting, drop the text.
					return { ...item, applyUrl: null, sectionsHtml: null, fallbackUrl };
				}
			}),
		),
	);
}
