import pLimit from "p-limit";
import { z } from "zod";
import { fetchJson } from "./http";

// ---------------------------------------------------------------------------
// bamboohr.ts — client for BambooHR public careers pages.
//   GET https://{token}.bamboohr.com/careers/list
//   → { result: [ { id, jobOpeningName, location:{city,state}, isRemote } ] }
//
// Like SmartRecruiters, the list omits the description; it lives on the
// per-job detail endpoint (…/careers/{id}/detail → result.jobOpening
// .description). We merge details under a small concurrency cap, and a failed
// detail degrades to a null description instead of failing the company.
// Ids arrive as strings OR numbers depending on tenant — the union absorbs
// both and normalize stringifies.
// ---------------------------------------------------------------------------

const ListItemSchema = z.object({
	id: z.union([z.string(), z.number()]),
	jobOpeningName: z.string(),
	location: z
		.object({
			city: z.string().nullish(),
			state: z.string().nullish(),
		})
		.nullish(),
	isRemote: z.boolean().nullish(),
});

const ListResponseSchema = z.object({
	result: z.array(ListItemSchema),
});

const DetailResponseSchema = z.object({
	result: z.object({
		jobOpening: z.object({
			description: z.string().nullish(), // HTML
		}),
	}),
});

export type BambooJob = z.infer<typeof ListItemSchema> & {
	descriptionHtml: string | null;
	/** Public posting URL, built from the tenant subdomain + job id. */
	url: string;
};

const DETAIL_CONCURRENCY = 5;

export async function fetchJobs(token: string): Promise<BambooJob[]> {
	const sub = encodeURIComponent(token);
	const base = `https://${sub}.bamboohr.com/careers`;
	const json = await fetchJson(`${base}/list`);
	const items = ListResponseSchema.parse(json).result;

	const limit = pLimit(DETAIL_CONCURRENCY);
	return Promise.all(
		items.map((item) =>
			limit(async (): Promise<BambooJob> => {
				const id = String(item.id);
				const url = `${base}/${encodeURIComponent(id)}`;
				try {
					const detail = DetailResponseSchema.parse(
						await fetchJson(`${base}/${encodeURIComponent(id)}/detail`),
					);
					return {
						...item,
						descriptionHtml: detail.result.jobOpening.description ?? null,
						url,
					};
				} catch {
					// Detail is enrichment, not identity: keep the posting, drop the text.
					return { ...item, descriptionHtml: null, url };
				}
			}),
		),
	);
}
