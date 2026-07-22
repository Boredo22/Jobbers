import pLimit from "p-limit";
import { z } from "zod";
import { AtsFetchError, fetchJson, postJson } from "./http";

// ---------------------------------------------------------------------------
// workday.ts — client for Workday's CXS job-board API (unofficial but stable;
// it's what every myworkdayjobs.com careers page calls from the browser).
//
//   POST https://{tenant}.{shard}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//        body { appliedFacets: {}, limit: 20, offset, searchText }
//   → { total, jobPostings: [ { title, externalPath, locationsText,
//       bulletFields: ["JR2018844"] } ] }
//
// Quirks vs. the boards we already poll:
//   1. Addressing needs THREE values (tenant + shard + career-site name), not
//      one slug — they live on the companies row as nullable workday_* columns.
//   2. The list is paginated at a hard 20 per page and carries no description;
//      that lives on the per-job detail endpoint (GET {base}{externalPath},
//      → jobPostingInfo.jobDescription as HTML). Same pattern as
//      SmartRecruiters: details are fetched with a small concurrency cap and a
//      failed detail degrades to a null description, never fails the company.
//   3. Enterprise boards run to THOUSANDS of postings. `searchText` narrows
//      server-side (the workday_search column); boards still over the page
//      cap fail loudly rather than fetch a truncated window — a partial fetch
//      would make run.ts's close-missing step mass-close the unseen tail.
// ---------------------------------------------------------------------------

const ListItemSchema = z.object({
	title: z.string(),
	externalPath: z.string(), // "/job/City/Title_JR123" — also the detail-endpoint path
	locationsText: z.string().nullish(),
	// Usually a single requisition id like "JR2018844" — the stable dedupe key
	// (externalPath embeds the title, so a retitled posting would change it).
	bulletFields: z.array(z.string()).nullish(),
});

const ListResponseSchema = z.object({
	total: z.number(),
	jobPostings: z.array(ListItemSchema).nullish(),
});

const DetailSchema = z.object({
	jobPostingInfo: z
		.object({
			jobDescription: z.string().nullish(), // HTML
			externalUrl: z.string().nullish(), // the public, human-facing posting URL
			location: z.string().nullish(),
			jobReqId: z.string().nullish(),
		})
		.nullish(),
});

export type WorkdayJob = {
	externalId: string;
	title: string;
	/** Best available location text (detail's `location`, else the list's). */
	locationsText: string | null;
	/** HTML job description; null when the detail fetch failed. */
	descriptionHtml: string | null;
	url: string;
};

const PAGE_SIZE = 20; // CXS hard cap — asking for more still returns 20
const MAX_PAGES = 50; // 1000 postings; boards past this must set workday_search
const DETAIL_CONCURRENCY = 5;

// The shard is interpolated into a hostname, so refuse anything that isn't the
// "wd" + digits pattern every Workday data center uses.
const SHARD_RE = /^wd\d+$/;

export async function fetchJobs(
	tenant: string,
	shard: string,
	site: string,
	search: string | null,
): Promise<WorkdayJob[]> {
	if (!SHARD_RE.test(shard)) {
		throw new AtsFetchError(
			`invalid workday shard "${shard}" (expected e.g. "wd1", "wd5")`,
		);
	}
	const host = `https://${encodeURIComponent(tenant)}.${shard}.myworkdayjobs.com`;
	const base = `${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

	const items: z.infer<typeof ListItemSchema>[] = [];
	// Quirk: with a searchText, only the FIRST page reports the real `total`
	// (later pages say 0) — so capture it once and never re-read it.
	let total = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const json = await postJson(`${base}/jobs`, {
			appliedFacets: {},
			limit: PAGE_SIZE,
			offset: page * PAGE_SIZE,
			searchText: search ?? "",
		});
		const parsed = ListResponseSchema.parse(json);
		if (page === 0) {
			total = parsed.total;
			if (total > MAX_PAGES * PAGE_SIZE) {
				// Fail the whole company rather than silently poll a truncated window
				// (see header note 3). The fix is a narrower workday_search term.
				throw new AtsFetchError(
					`workday board "${tenant}/${site}" reports ${total} postings — over the ${MAX_PAGES * PAGE_SIZE} cap; set workday_search to narrow it`,
				);
			}
		}
		const pageItems = parsed.jobPostings ?? [];
		items.push(...pageItems);
		if (items.length >= total || pageItems.length === 0) break;
	}

	const limit = pLimit(DETAIL_CONCURRENCY);
	return Promise.all(
		items.map((item) =>
			limit(async (): Promise<WorkdayJob> => {
				// Public posting URL, derivable without the detail fetch (the detail's
				// externalUrl, when present, is this exact shape).
				const fallbackUrl = `${host}/${encodeURIComponent(site)}${item.externalPath}`;
				const fallbackId = item.bulletFields?.[0] ?? item.externalPath;
				try {
					const detail = DetailSchema.parse(
						await fetchJson(`${base}${item.externalPath}`),
					);
					const info = detail.jobPostingInfo;
					return {
						externalId: info?.jobReqId ?? fallbackId,
						title: item.title,
						locationsText: info?.location ?? item.locationsText ?? null,
						descriptionHtml: info?.jobDescription ?? null,
						url: info?.externalUrl ?? fallbackUrl,
					};
				} catch {
					// Detail is enrichment, not identity: keep the posting, drop the text.
					return {
						externalId: fallbackId,
						title: item.title,
						locationsText: item.locationsText ?? null,
						descriptionHtml: null,
						url: fallbackUrl,
					};
				}
			}),
		),
	);
}
