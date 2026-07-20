import { PROPOSE_PROFILE_PROMPT, renderPrompt } from "@jobber/ai";
import {
	type HardFilters,
	type IdealJobProfile,
	IdealJobProfileSchema,
	type ProfileCriterion,
	type ProfileVersion,
} from "@jobber/shared";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
	applications,
	profiles,
	profileVersions,
	resumeVersions,
} from "../../db/schema";
import { createProvider, logAiRun } from "../../lib/ai";

// ---------------------------------------------------------------------------
// profile/service.ts — the Ideal Job Profile (Phase 3, step 3.1).
//
// The profile is the rubric the scorer grades against. v1 is honest and simple:
// a one-shot AI call *proposes* a profile from your notes + resume + application
// history; you edit and save it as a profile_versions row. The scorer already
// consumes {{profile}}, so a saved profile immediately sharpens future scores.
// ---------------------------------------------------------------------------

const RESUME_FALLBACK = "(No resume on file yet — Phase 3.2 adds upload.)";

// The track a fresh DB gets when nothing exists yet — same name the backfill
// script (backfill-profiles.ts) uses, so the two paths converge on one row.
const DEFAULT_TRACK_NAME = "AI Implementation";

/**
 * The track (profiles row) that new profile versions and scores attach to,
 * until multi-profile stage 2 makes callers track-aware. Oldest active track
 * wins; if the table is somehow empty (fresh DB, backfill never run), it
 * creates the default track rather than writing another orphan row — the
 * whole point is that nothing inserted after the multi-profile migration has
 * profile_id = null.
 */
export async function defaultTrackId(): Promise<string> {
	const [track] = await db
		.select({ id: profiles.id })
		.from(profiles)
		.orderBy(desc(profiles.active), profiles.createdAt)
		.limit(1);
	if (track) return track.id;

	// Empty table: create the default. onConflictDoNothing + re-select makes a
	// concurrent first-write race resolve to the same row instead of throwing
	// on the unique name.
	const [created] = await db
		.insert(profiles)
		.values({ name: DEFAULT_TRACK_NAME, active: true })
		.onConflictDoNothing({ target: profiles.name })
		.returning({ id: profiles.id });
	if (created) return created.id;
	const [existing] = await db
		.select({ id: profiles.id })
		.from(profiles)
		.where(eq(profiles.name, DEFAULT_TRACK_NAME))
		.limit(1);
	if (!existing) throw new Error("defaultTrackId: could not resolve a track");
	return existing.id;
}

/** A compact summary of recent applications — revealed preference for the AI. */
async function applicationsSummary(): Promise<string> {
	const rows = await db
		.select({
			company: applications.companyName,
			role: applications.roleTitle,
			status: applications.status,
		})
		.from(applications)
		.orderBy(desc(applications.appliedAt))
		.limit(40);
	if (rows.length === 0) return "(No applications on record.)";
	return rows.map((r) => `- ${r.role} @ ${r.company} (${r.status})`).join("\n");
}

/** The active resume's extracted text, or a placeholder. */
async function activeResumeText(): Promise<string> {
	const [row] = await db
		.select({ text: resumeVersions.extractedText })
		.from(resumeVersions)
		.where(eq(resumeVersions.active, true))
		.limit(1);
	return row?.text ?? RESUME_FALLBACK;
}

/**
 * Ask the model to PROPOSE a profile from the available signals. Returns a draft
 * (not saved) — the human edits it before it becomes a version. Uses the "large"
 * tier: this is a rare, quality-critical call, unlike bulk scoring.
 */
export async function proposeProfile(notes?: string): Promise<IdealJobProfile> {
	const [resume, apps] = await Promise.all([
		activeResumeText(),
		applicationsSummary(),
	]);

	const prompt = renderPrompt(PROPOSE_PROFILE_PROMPT, {
		notes: notes?.trim() || "(No notes provided.)",
		resume,
		applications: apps,
	});

	const provider = createProvider();
	const result = await provider.complete({
		prompt,
		schema: IdealJobProfileSchema,
		schemaName: "ideal_job_profile",
		tier: "large",
		maxTokens: 2048,
	});
	await logAiRun("profile", result);
	return result.data;
}

/**
 * Coerce a stored rubric's hardFilters (unknown jsonb) into the current
 * HardFilters shape, defaulting each field. This is what lets us ADD a field
 * (compCeiling) without a migration: profiles saved before it simply read back as
 * null, rather than failing the response schema on the missing key.
 */
function normalizeHardFilters(raw: unknown): HardFilters {
	const hf = (raw ?? {}) as Record<string, unknown>;
	return {
		compFloor: typeof hf.compFloor === "number" ? hf.compFloor : null,
		compCeiling: typeof hf.compCeiling === "number" ? hf.compCeiling : null,
		locationRule: typeof hf.locationRule === "string" ? hf.locationRule : "",
		remoteRequired: hf.remoteRequired === true,
	};
}

/** Recombine a profile_versions row into the flat ProfileVersion wire shape. */
function toProfileVersion(
	row: typeof profileVersions.$inferSelect,
): ProfileVersion {
	return {
		id: row.id,
		version: row.version,
		active: row.active,
		createdAt: row.createdAt,
		northStar: row.northStar,
		hardFilters: normalizeHardFilters(row.rubric?.hardFilters),
		criteria: (row.rubric?.criteria ?? []) as ProfileCriterion[],
	};
}

/** The active profile, or null if none has been saved yet. */
export async function getActiveProfile(): Promise<ProfileVersion | null> {
	const [row] = await db
		.select()
		.from(profileVersions)
		.where(eq(profileVersions.active, true))
		.limit(1);
	return row ? toProfileVersion(row) : null;
}

/**
 * The active profile's comp ceiling (max base worth pursuing), or null if there's
 * no active profile or no ceiling set. The scoring pipeline uses this to hard-drop
 * postings whose disclosed base floor is above it — see scoring/queue + triage.
 */
export async function getActiveCompCeiling(): Promise<number | null> {
	const profile = await getActiveProfile();
	return profile?.hardFilters.compCeiling ?? null;
}

/**
 * Save a profile as a NEW version and make it the active one *within its
 * track*. Versions are append-only (like prompts): editing produces v(N+1),
 * old scores keep pointing at the version that graded them. Deactivate-others
 * + insert-active runs in one transaction so there's never zero or two active
 * profiles per track. The deactivate is scoped to the track (plus any stray
 * null-track rows) so that when a second track exists, saving one can't
 * clobber the other's active version.
 */
export async function saveProfile(
	profile: IdealJobProfile,
): Promise<ProfileVersion> {
	const trackId = await defaultTrackId();
	return db.transaction(async (tx) => {
		const maxRows = await tx
			.select({
				max: sql<number>`coalesce(max(${profileVersions.version}), 0)`,
			})
			.from(profileVersions);
		const max = maxRows[0]?.max ?? 0;

		await tx
			.update(profileVersions)
			.set({ active: false })
			.where(
				and(
					eq(profileVersions.active, true),
					or(
						eq(profileVersions.profileId, trackId),
						isNull(profileVersions.profileId),
					),
				),
			);

		const [row] = await tx
			.insert(profileVersions)
			.values({
				profileId: trackId,
				version: max + 1,
				northStar: profile.northStar,
				rubric: {
					hardFilters: profile.hardFilters,
					criteria: profile.criteria,
				},
				active: true,
			})
			.returning();

		if (!row) throw new Error("saveProfile: insert returned no row");
		return toProfileVersion(row);
	});
}
