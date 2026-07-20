import type { TailorEdit } from "@jobber/shared";
import { describe, expect, it } from "vitest";
import { ADDITIONS_HEADER, applyEdits } from "./assemble";

// ---------------------------------------------------------------------------
// assemble.test.ts — the highest-value test in tailor-v2 (spec, step T3).
//
// applyEdits is where the never-invent guarantee is enforced mechanically, so its
// edge cases are exactly what pays rent: verbatim replacement, first-occurrence-
// only, empty-original additions, loose quotes reported as failures, and several
// edits threaded through one document.
// ---------------------------------------------------------------------------

/** Small helper: build a TailorEdit without repeating the four fields each time. */
function edit(partial: Partial<TailorEdit>): TailorEdit {
	return {
		section: "Summary",
		original: "",
		tailored: "",
		rationale: "because",
		...partial,
	};
}

describe("applyEdits", () => {
	it("replaces an edit's original with its tailored text", () => {
		const base = "Led a team of 3 engineers.";
		const { text, applied, failed } = applyEdits(base, [
			edit({
				original: "a team of 3 engineers",
				tailored: "a team of 8 engineers",
			}),
		]);
		expect(text).toBe("Led a team of 8 engineers.");
		expect(applied).toHaveLength(1);
		expect(failed).toHaveLength(0);
	});

	it("replaces only the FIRST occurrence of original", () => {
		const base = "Python. Later, more Python.";
		const { text } = applyEdits(base, [
			edit({ original: "Python", tailored: "Go" }),
		]);
		// Second "Python" is left untouched — one edit, one replacement.
		expect(text).toBe("Go. Later, more Python.");
	});

	it("appends empty-original edits under the additions block", () => {
		const base = "Existing resume body.";
		const { text, applied, failed } = applyEdits(base, [
			edit({
				section: "Skills",
				original: "",
				tailored: "Kubernetes, Terraform",
			}),
		]);
		expect(failed).toHaveLength(0);
		expect(applied).toHaveLength(1);
		expect(text).toContain("Existing resume body.");
		expect(text).toContain(ADDITIONS_HEADER);
		expect(text).toContain("- (Skills) Kubernetes, Terraform");
		// The original body must survive verbatim ahead of the additions block.
		expect(text.indexOf("Existing resume body.")).toBeLessThan(
			text.indexOf(ADDITIONS_HEADER),
		);
	});

	it("reports an original that isn't found verbatim as failed, leaving text unchanged", () => {
		const base = "Managed cloud infrastructure.";
		const { text, applied, failed } = applyEdits(base, [
			edit({
				original: "managed cloud infra", // loose quote — wrong case + truncated
				tailored: "Owned cloud infrastructure",
			}),
		]);
		expect(text).toBe(base); // nothing changed
		expect(applied).toHaveLength(0);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.tailored).toBe("Owned cloud infrastructure");
	});

	it("applies multiple edits across one document in order", () => {
		const base = "Summary line.\nExperience: built X.\nSkills: A, B.";
		const { text, applied, failed } = applyEdits(base, [
			edit({ original: "built X", tailored: "built and shipped X" }),
			edit({ original: "A, B", tailored: "A, B, C" }),
			edit({ section: "Skills", original: "", tailored: "Extra credential" }),
		]);
		expect(failed).toHaveLength(0);
		expect(applied).toHaveLength(3);
		expect(text).toContain("built and shipped X");
		expect(text).toContain("A, B, C");
		expect(text).toContain("- (Skills) Extra credential");
	});

	it("treats original as a literal string, not a regex", () => {
		const base = "Cost was $5 (approx).";
		const { text, failed } = applyEdits(base, [
			edit({ original: "$5 (approx)", tailored: "$6 (approx)" }),
		]);
		// Regex-special chars ($, parens) must match literally.
		expect(text).toBe("Cost was $6 (approx).");
		expect(failed).toHaveLength(0);
	});
});
