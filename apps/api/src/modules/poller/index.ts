import type { AtsType } from "@jobber/shared";
import * as ashby from "./ashby";
import * as bamboohr from "./bamboohr";
import * as breezy from "./breezy";
import * as greenhouse from "./greenhouse";
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
} from "./normalize";
import * as recruitee from "./recruitee";
import * as smartrecruiters from "./smartrecruiters";
import * as workable from "./workable";

// ---------------------------------------------------------------------------
// index.ts — the adapter registry. One place that knows "for platform X, fetch
// with this client and normalize with that mapper". The poll runner (step 1.4)
// just does `adapters[company.atsType](company.atsToken)` — it never touches a
// platform-specific detail. Adding a 4th ATS later = one new file + one line
// here.
// ---------------------------------------------------------------------------

/** Every ATS type except "manual" (manual companies have no pollable API). */
export type PollableAtsType = Exclude<AtsType, "manual">;

/** The uniform interface each platform is reduced to: token → normalized rows. */
export type Adapter = (token: string) => Promise<NormalizedPosting[]>;

export const adapters: Record<PollableAtsType, Adapter> = {
	greenhouse: async (token) =>
		normalizeGreenhouse(await greenhouse.fetchJobs(token)),
	lever: async (token) => normalizeLever(await lever.fetchJobs(token)),
	ashby: async (token) => normalizeAshby(await ashby.fetchJobs(token)),
	smartrecruiters: async (token) =>
		normalizeSmartRecruiters(await smartrecruiters.fetchJobs(token)),
	workable: async (token) => normalizeWorkable(await workable.fetchJobs(token)),
	recruitee: async (token) =>
		normalizeRecruitee(await recruitee.fetchJobs(token)),
	breezy: async (token) => normalizeBreezy(await breezy.fetchJobs(token)),
	bamboohr: async (token) => normalizeBamboo(await bamboohr.fetchJobs(token)),
};

export type { NormalizedPosting } from "./normalize";
