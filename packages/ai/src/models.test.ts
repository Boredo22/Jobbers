import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./models";

// ---------------------------------------------------------------------------
// models.test.ts — pricing must survive the alias/snapshot mismatch. We *send*
// the alias ("claude-haiku-4-5") but the API *reports* a dated snapshot
// ("claude-haiku-4-5-20251001"); the ledger has to price the snapshot correctly.
// This is the exact bug that shipped NULL est_cost until the prefix match landed.
// ---------------------------------------------------------------------------

describe("estimateCostUsd", () => {
	it("prices a dated model snapshot via its alias prefix", () => {
		// Haiku: $1/1M in, $5/1M out. 1,000,000 in + 1,000,000 out = $1 + $5 = $6.
		const cost = estimateCostUsd(
			"claude-haiku-4-5-20251001",
			1_000_000,
			1_000_000,
		);
		expect(cost).toBeCloseTo(6.0, 6);
	});

	it("prices the bare alias too", () => {
		expect(estimateCostUsd("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(
			1.0,
			6,
		);
	});

	it("returns null for an unknown model rather than a fake $0", () => {
		expect(estimateCostUsd("some-unknown-model", 1000, 1000)).toBeNull();
	});
});
