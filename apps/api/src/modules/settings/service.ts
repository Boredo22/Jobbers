import {
	type AiModelSettings,
	AiModelSettingsSchema,
	type PrefilterSettings,
	PrefilterSettingsSchema,
} from "@jobber/shared";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../../db/client";
import { appSettings } from "../../db/schema";
import { DEFAULT_PREFILTER_SETTINGS } from "../poller/prefilter";

// ---------------------------------------------------------------------------
// settings/service.ts — read/write runtime-editable config in app_settings.
//
// The table is a generic key/value (jsonb) store; each key gets a typed
// wrapper built on two generic helpers. The stored value re-crosses its Zod
// boundary on every read: if a migration or hand-edit ever mangles a row, the
// parse throws at the API layer instead of a feature silently misbehaving.
// Reads are one PK lookup — noise next to what the callers do with them (an
// ATS poll, an LLM round-trip), so there's deliberately no cache to invalidate.
// ---------------------------------------------------------------------------

/** Read one setting through its schema. Row missing → null (caller defaults). */
async function getSetting<T>(
	key: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	const [row] = await db
		.select({ value: appSettings.value })
		.from(appSettings)
		.where(eq(appSettings.key, key));
	if (!row) return null;
	return schema.parse(row.value);
}

/** Upsert one setting (insert first save, update after), bumping updatedAt. */
async function putSetting(key: string, value: unknown): Promise<void> {
	await db
		.insert(appSettings)
		.values({ key, value })
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value, updatedAt: new Date() },
		});
}

// --- prefilter: the editable title-keyword lists ---------------------------

const PREFILTER_KEY = "prefilter";

export async function getPrefilterSettings(): Promise<PrefilterSettings> {
	return (
		(await getSetting(PREFILTER_KEY, PrefilterSettingsSchema)) ??
		DEFAULT_PREFILTER_SETTINGS
	);
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
	await putSetting(PREFILTER_KEY, value);
	return value;
}

// --- ai-models: which OpenRouter model serves each tier --------------------

const AI_MODELS_KEY = "ai-models";

/** Null until the first save — the OpenRouter provider then uses defaults. */
export async function getAiModelSettings(): Promise<AiModelSettings | null> {
	return getSetting(AI_MODELS_KEY, AiModelSettingsSchema);
}

export async function putAiModelSettings(
	value: AiModelSettings,
): Promise<AiModelSettings> {
	await putSetting(AI_MODELS_KEY, value);
	return value;
}
