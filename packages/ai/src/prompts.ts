import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// prompts.ts — prompts live as versioned markdown files, not string literals.
//
// Why files, and why versioned: a prompt is the most-tuned, least-stable part of
// an AI feature. Keeping each version as its own file (score-job.v1.md, then
// v2.md, …) means (a) prompt edits show up as readable diffs in git, and (b) the
// version string can be stored on each fit_scores row — so when you rewrite the
// prompt and bump the file, *old* scores stay interpretable ("this was graded by
// v1"). Editing a prompt in place would silently make historical scores lie.
//
// The renderer is deliberately tiny — a regex replace, no template library. Every
// {{placeholder}} must be supplied; a missing one throws rather than shipping
// literal "{{jd}}" text to the model (a silent, expensive mistake).
// ---------------------------------------------------------------------------

// Prompt files live in packages/ai/prompts/ — a sibling of src/. Resolving from
// this module's URL (not cwd) means it works under tsx, Vitest, and Vite alike,
// wherever the process was launched. (Production bundling ships this dir — 8.1.)
const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

/** The current scoring prompt. Bump this constant when you add score-job.v2.md. */
export const SCORE_JOB_PROMPT = "score-job.v1.md";

/**
 * Read a prompt file and substitute every {{placeholder}} from `vars`.
 * Throws if the file references a placeholder `vars` doesn't provide — a missing
 * variable is a bug, not something to paper over by sending the model raw braces.
 */
export function renderPrompt(
	promptFile: string,
	vars: Record<string, string>,
): string {
	const raw = readFileSync(new URL(promptFile, PROMPTS_DIR), "utf8");
	return raw.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		if (!(key in vars)) {
			throw new Error(
				`renderPrompt: prompt "${promptFile}" needs {{${key}}}, but it wasn't provided.`,
			);
		}
		return vars[key] ?? "";
	});
}

/**
 * The version tag embedded in a prompt filename ("score-job.v1.md" → "v1").
 * Stored alongside each score so a row records which prompt graded it. Throws on
 * an unversioned filename, so a prompt can't slip in without a version.
 */
export function promptVersion(promptFile: string): string {
	const match = promptFile.match(/\.(v\d+)\.md$/);
	if (!match) {
		throw new Error(
			`promptVersion: "${promptFile}" has no vN version tag in its name.`,
		);
	}
	return match[1] as string;
}
