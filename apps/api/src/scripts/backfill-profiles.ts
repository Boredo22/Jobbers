import { eq, isNull, sql } from "drizzle-orm";
import { db, queryClient } from "../db/client";
import {
	fitScores,
	profiles,
	profileVersions,
	resumeVersions,
} from "../db/schema";

// ---------------------------------------------------------------------------
// backfill-profiles.ts — one-off, idempotent data migration for multi-profile.
//
// The multi-profile schema adds a `profiles` (track) table and a nullable
// profile_id on profile_versions + fit_scores. Existing data predates tracks, so
// this script folds it all into one default track ("AI Implementation" — the
// owner's current focus): create the track (pointed at the active resume), then
// link every orphan version and score to it. Safe to re-run — it only touches
// rows whose profile_id is still null.
//
//   pnpm --filter api backfill:profiles
// ---------------------------------------------------------------------------

const DEFAULT_NAME = "AI Implementation";

async function main() {
	// Find or create the default track. Its resume defaults to the currently
	// active resume version, so scoring behaves exactly as before the migration.
	let [track] = await db
		.select()
		.from(profiles)
		.where(eq(profiles.name, DEFAULT_NAME))
		.limit(1);

	if (!track) {
		const [activeResume] = await db
			.select({ id: resumeVersions.id })
			.from(resumeVersions)
			.where(eq(resumeVersions.active, true))
			.limit(1);
		[track] = await db
			.insert(profiles)
			.values({
				name: DEFAULT_NAME,
				resumeVersionId: activeResume?.id ?? null,
				active: true,
			})
			.returning();
		if (!track) throw new Error("failed to create default profile");
		console.log(
			`Created default track "${DEFAULT_NAME}" (${track.id}), resume=${
				activeResume?.id ?? "none"
			}`,
		);
	} else {
		console.log(
			`Default track "${DEFAULT_NAME}" already exists (${track.id}).`,
		);
	}

	// Link orphan versions + scores (only those not yet assigned to any track).
	const versions = await db
		.update(profileVersions)
		.set({ profileId: track.id })
		.where(isNull(profileVersions.profileId))
		.returning({ id: profileVersions.id });

	const [{ n: orphanScores } = { n: 0 }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(fitScores)
		.where(isNull(fitScores.profileId));

	await db
		.update(fitScores)
		.set({ profileId: track.id })
		.where(isNull(fitScores.profileId));

	console.log(
		`Linked ${versions.length} profile version(s) and ${orphanScores} score(s) to "${DEFAULT_NAME}".`,
	);
}

try {
	await main();
} catch (err) {
	console.error("backfill-profiles failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
