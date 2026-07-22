import type { AtsType } from "@jobber/shared";
import * as ashby from "./ashby";
import * as bamboohr from "./bamboohr";
import * as breezy from "./breezy";
import * as greenhouse from "./greenhouse";
import { AtsFetchError } from "./http";
import * as lever from "./lever";
import {
	type NormalizedPosting,
	normalizeAshby,
	normalizeBamboo,
	normalizeBreezy,
	normalizeGreenhouse,
	normalizeLever,
	normalizeRecruitee,
	normalizeSmartRecruiters,
	normalizeWorkable,
	normalizeWorkday,
} from "./normalize";
import * as recruitee from "./recruitee";
import * as smartrecruiters from "./smartrecruiters";
import * as workable from "./workable";
import * as workday from "./workday";

// ---------------------------------------------------------------------------
// index.ts — the adapter registry. One place that knows "for platform X, fetch
// with this client and normalize with that mapper". The poll runner (step 1.4)
// just does `adapters[company.atsType](target)` — it never touches a
// platform-specific detail. Adding a 4th ATS later = one new file + one line
// here.
// ---------------------------------------------------------------------------

/** Every ATS type except "manual" (manual companies have no pollable API). */
export type PollableAtsType = Exclude<AtsType, "manual">;

/**
 * Everything a company row knows about reaching its board. For all boards but
 * Workday, `token` (the board slug) is the whole story; Workday additionally
 * needs its shard + career-site name (and optionally a narrowing search).
 */
export type PollTarget = {
	token: string;
	workdayShard: string | null;
	workdaySite: string | null;
	workdaySearch: string | null;
};

/** The uniform interface each platform is reduced to: target → normalized rows. */
export type Adapter = (target: PollTarget) => Promise<NormalizedPosting[]>;

export const adapters: Record<PollableAtsType, Adapter> = {
	greenhouse: async ({ token }) =>
		normalizeGreenhouse(await greenhouse.fetchJobs(token)),
	lever: async ({ token }) => normalizeLever(await lever.fetchJobs(token)),
	ashby: async ({ token }) => normalizeAshby(await ashby.fetchJobs(token)),
	smartrecruiters: async ({ token }) =>
		normalizeSmartRecruiters(await smartrecruiters.fetchJobs(token)),
	workable: async ({ token }) =>
		normalizeWorkable(await workable.fetchJobs(token)),
	recruitee: async ({ token }) =>
		normalizeRecruitee(await recruitee.fetchJobs(token)),
	breezy: async ({ token }) => normalizeBreezy(await breezy.fetchJobs(token)),
	bamboohr: async ({ token }) =>
		normalizeBamboo(await bamboohr.fetchJobs(token)),
	workday: async ({ token, workdayShard, workdaySite, workdaySearch }) => {
		// Misconfiguration surfaces here as a per-company poll failure (run.ts
		// catches and records it), not a crash of the whole run.
		if (!workdayShard || !workdaySite) {
			throw new AtsFetchError(
				`workday company "${token}" needs workday_shard + workday_site set (e.g. "wd5" + "NVIDIAExternalCareerSite")`,
			);
		}
		return normalizeWorkday(
			await workday.fetchJobs(token, workdayShard, workdaySite, workdaySearch),
		);
	},
};

export type { NormalizedPosting } from "./normalize";
