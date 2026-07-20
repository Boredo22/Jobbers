import { describe, expect, it } from "vitest";
import { promptVersion, renderPrompt, SCORE_JOB_PROMPT } from "./prompts";

// ---------------------------------------------------------------------------
// prompts.test.ts — the project's first unit test. Prompt rendering is a pure,
// deterministic function with sharp edges (missing vars, version parsing), which
// is exactly where a test pays rent (CLAUDE.md §3). Every case runs against the
// real score-job.v1.md file, so the test also guards the shipped prompt's shape.
// ---------------------------------------------------------------------------

describe("renderPrompt", () => {
	it("substitutes every placeholder in the real v1 scoring prompt", () => {
		const out = renderPrompt(SCORE_JOB_PROMPT, {
			profile: "PROFILE_TEXT",
			resume: "RESUME_TEXT",
			jd: "JD_TEXT",
		});
		// All three placeholders replaced with the supplied values...
		expect(out).toContain("PROFILE_TEXT");
		expect(out).toContain("RESUME_TEXT");
		expect(out).toContain("JD_TEXT");
		// ...and none left un-substituted.
		expect(out).not.toMatch(/\{\{\w+\}\}/);
	});

	it("throws when a required placeholder is missing", () => {
		expect(() =>
			// Omit `jd` — the v1 file needs it, so this must be a loud error, not a
			// prompt silently containing "{{jd}}".
			renderPrompt(SCORE_JOB_PROMPT, {
				profile: "p",
				resume: "r",
			}),
		).toThrow(/\{\{jd\}\}/);
	});
});

describe("promptVersion", () => {
	it("extracts the version tag from a filename", () => {
		expect(promptVersion("score-job.v1.md")).toBe("v1");
		expect(promptVersion("score-job.v12.md")).toBe("v12");
	});

	it("throws on an unversioned filename", () => {
		expect(() => promptVersion("score-job.md")).toThrow();
	});
});
