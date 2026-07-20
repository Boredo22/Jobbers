import { readFileSync } from "node:fs";
import { AtsTypeSchema } from "@jobber/shared";
import { z } from "zod";
import { adapters } from "../modules/poller";
import { AtsFetchError } from "../modules/poller/http";

// ---------------------------------------------------------------------------
// validate-tokens.ts — the step 1.3 checkpoint AND your token-health pass.
//
// Run:  pnpm --filter api validate-tokens
//
// It hits every board in data/companies.json through the real adapters, so it
// proves two things at once:
//   1. the fetch → validate → normalize pipeline works against live APIs, and
//   2. which tokens are dead (404) or otherwise failing — the boards to fix.
//
// It only reads public, unauthenticated ATS endpoints. No DB writes.
// ---------------------------------------------------------------------------

const CompanySchema = z.object({
	name: z.string(),
	atsType: AtsTypeSchema,
	atsToken: z.string(),
});
const companies = z
	.array(CompanySchema)
	.parse(
		JSON.parse(
			readFileSync(
				new URL("../../data/companies.json", import.meta.url),
				"utf8",
			),
		),
	);

type CheckResult = {
	name: string;
	atsType: string;
	token: string;
	ok: boolean;
	count: number;
	status: number | undefined;
	error: string | undefined;
	sample: unknown;
};

/**
 * Run an async fn over items with at most `limit` in flight — a polite cap so we
 * don't fire 68 requests at once. (Step 1.4 replaces this hand-rolled pool with
 * the `p-limit` library; here it keeps the script dependency-free.)
 */
async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const idx = next++;
			// biome-ignore lint/style/noNonNullAssertion: idx < items.length holds
			results[idx] = await fn(items[idx]!);
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
	await Promise.all(workers);
	return results;
}

const results = await mapWithConcurrency(
	companies,
	5,
	async (c): Promise<CheckResult> => {
		if (c.atsType === "manual") {
			return {
				name: c.name,
				atsType: c.atsType,
				token: c.atsToken,
				ok: true,
				count: 0,
				status: undefined,
				error: undefined,
				sample: undefined,
			};
		}
		// After the guard, atsType is narrowed to a pollable platform → indexes the registry.
		const adapter = adapters[c.atsType];
		try {
			const postings = await adapter(c.atsToken);
			return {
				name: c.name,
				atsType: c.atsType,
				token: c.atsToken,
				ok: true,
				count: postings.length,
				status: 200,
				error: undefined,
				sample: postings[0],
			};
		} catch (err) {
			if (err instanceof AtsFetchError) {
				return {
					name: c.name,
					atsType: c.atsType,
					token: c.atsToken,
					ok: false,
					count: 0,
					status: err.status,
					error: err.message,
					sample: undefined,
				};
			}
			// Anything else (most likely a Zod parse failure = unexpected response shape).
			return {
				name: c.name,
				atsType: c.atsType,
				token: c.atsToken,
				ok: false,
				count: 0,
				status: undefined,
				error: err instanceof Error ? err.message : String(err),
				sample: undefined,
			};
		}
	},
);

// --- Summary ---------------------------------------------------------------
const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const totalPostings = ok.reduce((sum, r) => sum + r.count, 0);

console.log("\n===== token validation =====");
console.log(`boards checked: ${results.length}`);
console.log(`ok: ${ok.length}   failing: ${failed.length}`);
console.log(`total postings fetched: ${totalPostings}`);

if (failed.length > 0) {
	console.log("\n--- failing boards (fix or drop these) ---");
	for (const r of failed) {
		const reason = r.status ? `HTTP ${r.status}` : (r.error ?? "unknown");
		console.log(`  [${r.atsType}] ${r.name} (${r.token}) → ${reason}`);
	}
}

// --- One normalized posting per platform (proves the mapping) --------------
console.log("\n--- sample normalized posting per platform ---");
// Derived from the registry, so a newly added ATS shows up here automatically.
for (const platform of Object.keys(adapters) as (keyof typeof adapters)[]) {
	// Only report platforms that actually have boards in companies.json.
	if (!companies.some((c) => c.atsType === platform)) continue;
	const withSample = ok.find((r) => r.atsType === platform && r.sample);
	if (withSample) {
		console.log(`\n[${platform}] ${withSample.name}:`);
		console.log(JSON.stringify(withSample.sample, null, 2));
	} else {
		console.log(`\n[${platform}] (no open postings found to sample)`);
	}
}
