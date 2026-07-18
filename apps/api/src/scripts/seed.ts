import { readFileSync } from "node:fs";
import { AtsTypeSchema } from "@jobber/shared";
import { z } from "zod";
import { db, queryClient } from "../db/client";
import { companies } from "../db/schema";

// ---------------------------------------------------------------------------
// seed.ts — load the target companies from data/companies.json into the DB.
//
// Run:  pnpm --filter api seed
//
// Idempotent by design: run it as many times as you like. New companies get
// inserted; ones already present are skipped (never duplicated, never
// overwritten). That safety comes from UNIQUE(name) + onConflictDoNothing.
// ---------------------------------------------------------------------------

// The shape of ONE row in companies.json. This is the Zod boundary
// (CLAUDE.md §4): the JSON file is external input, so we validate it before a
// single value reaches the database. A typo like a bad atsType fails loudly
// here instead of silently poisoning the poller later.
const CompanySeedSchema = z.object({
	name: z.string().min(1),
	atsType: AtsTypeSchema, // reuse the shared enum — one source of truth
	atsToken: z.string().min(1),
	tier: z.enum(["A", "B", "C", "C-travel"]),
});
type CompanySeed = z.infer<typeof CompanySeedSchema>;

// The whole file is an array of those.
const CompanySeedFileSchema = z.array(CompanySeedSchema);

// Your A/B/C tiers → the schema's numeric fitGroup (Group 1–5). We only use
// 1–3 today; the range leaves room to get more granular later.
const TIER_TO_FIT_GROUP: Record<CompanySeed["tier"], number> = {
	A: 1,
	B: 2,
	C: 3,
	"C-travel": 3,
};

async function seed() {
	// import.meta.dirname is this file's folder (src/scripts); the data dir is a
	// sibling of src, so go up two levels. Resolving from the source file (not
	// cwd) means the script works no matter where it's launched from.
	const dataPath = new URL("../../data/companies.json", import.meta.url);
	const raw: unknown = JSON.parse(readFileSync(dataPath, "utf8"));

	// .parse throws a detailed error if the file is malformed. After this line,
	// `seeds` is fully typed — no `any`, no defensive checks downstream.
	const seeds = CompanySeedFileSchema.parse(raw);

	// Defensive de-dupe within the file itself (last write wins), so a stray
	// duplicate name in the JSON can't blow up the batch insert.
	const byName = new Map<string, CompanySeed>();
	for (const s of seeds) byName.set(s.name, s);

	const rows = [...byName.values()].map((s) => ({
		name: s.name,
		atsType: s.atsType,
		atsToken: s.atsToken,
		fitGroup: TIER_TO_FIT_GROUP[s.tier],
		notes:
			s.tier === "C-travel" ? "tier C — travel required" : `tier ${s.tier}`,
		active: true,
	}));

	// The idempotent insert. onConflictDoNothing needs a conflict *target* — the
	// UNIQUE(name) constraint — to know which rows already exist. .returning()
	// gives back only the rows actually inserted, so we can report inserted vs
	// skipped honestly.
	const inserted = await db
		.insert(companies)
		.values(rows)
		.onConflictDoNothing({ target: companies.name })
		.returning({ id: companies.id });

	console.log(
		`Seed complete: ${rows.length} companies in file, ${inserted.length} newly inserted, ${rows.length - inserted.length} already present.`,
	);
}

// Run, then always close the pool so the process exits (a script isn't a
// long-lived server). try/finally guarantees the connection closes even if the
// insert throws.
try {
	await seed();
} catch (err) {
	console.error("Seed failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
