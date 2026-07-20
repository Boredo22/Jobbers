import { describe, expect, it } from "vitest";
import { pickBaseVersionId } from "./service";

// ---------------------------------------------------------------------------
// service.test.ts — the base-resolution precedence (tailor-v2, step T2).
//
// pickBaseVersionId is the pure heart of "which resume do we tailor from?": an
// explicit pick wins, then the track's own resume, then the globally-active one.
// Pulling the precedence out of the DB code is exactly what makes it testable —
// no Postgres, no mocks, just the rule (CLAUDE.md §3: tests where they pay rent).
// ---------------------------------------------------------------------------

describe("pickBaseVersionId", () => {
	it("prefers an explicit pick over everything", () => {
		expect(
			pickBaseVersionId({
				explicit: "explicit-id",
				trackResumeVersionId: "track-id",
				activeResumeVersionId: "active-id",
			}),
		).toBe("explicit-id");
	});

	it("falls back to the track's resume when no explicit pick", () => {
		expect(
			pickBaseVersionId({
				explicit: null,
				trackResumeVersionId: "track-id",
				activeResumeVersionId: "active-id",
			}),
		).toBe("track-id");
	});

	it("falls back to the globally-active resume when neither is set", () => {
		expect(
			pickBaseVersionId({
				explicit: null,
				trackResumeVersionId: null,
				activeResumeVersionId: "active-id",
			}),
		).toBe("active-id");
	});

	it("returns null when nothing resolves (caller → NoActiveResumeError)", () => {
		expect(pickBaseVersionId({})).toBeNull();
	});

	it("treats undefined the same as null (missing, not chosen)", () => {
		expect(
			pickBaseVersionId({
				explicit: undefined,
				trackResumeVersionId: undefined,
				activeResumeVersionId: "active-id",
			}),
		).toBe("active-id");
	});
});
