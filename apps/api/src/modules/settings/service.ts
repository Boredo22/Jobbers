import {
	type PrefilterSettings,
	PrefilterSettingsSchema,
} from "@jobber/shared";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import { DEFAULT_PREFILTER_SETTINGS } from "../poller/prefilter";

// ---------------------------------------------------------------------------
// settings/service.ts — read/write the editable prefilter keyword lists.
//
// One app_settings row (key "prefilter") holds both lists as jsonb. Reads fall
// back to the in-code defaults until the first save, so a fresh DB behaves
// exactly like the pre-settings app. The stored value re-crosses the Zod
// boundary on every read: if a migration or hand-edit ever mangles the row,
// the parse throws at the API layer instead of the prefilter silently matching
// nothing.
// ---------------------------------------------------------------------------

const PREFILTER_KEY = "prefilter";

export async function getPrefilterSettings(): Promise<PrefilterSettings> {
	const [row] = await db
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, PREFILTER_KEY));
	if (!row) return DEFAULT_PREFILTER_SETTINGS;
	return PrefilterSettingsSchema.parse(row.value);
}

/**
 * Keywords are matched as lowercase substrings against lowercased titles, so
 * normalize what the user typed: trim, lowercase, drop empties, dedupe (Set
 * keeps first occurrence, preserving the user's ordering).
 */
function normalizeKeywords(list: string[]): string[] {
	return [
		...new Set(list.map((k) => k.trim().toLowerCase()).filter((k) => k !== "")),
	];
}

export async function savePrefilterSettings(
	input: PrefilterSettings,
): Promise<PrefilterSettings> {
	const value: PrefilterSettings = {
		includeTitleKeywords: normalizeKeywords(input.includeTitleKeywords),
		excludeTitleKeywords: normalizeKeywords(input.excludeTitleKeywords),
	};
	await db
		.insert(appSettings)
		.values({ key: PREFILTER_KEY, value })
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value, updatedAt: new Date() },
		});
	return value;
}
