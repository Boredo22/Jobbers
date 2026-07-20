import type { TailorEdit } from "@jobber/shared";

// ---------------------------------------------------------------------------
// assemble.ts — turn reviewed edits into a full tailored resume, deterministically.
//
// The whole never-invent guarantee rides on this being a pure text transform, not
// a second AI call: the ONLY text that can change is text an edit's `original`
// quoted verbatim (and the human already reviewed every edit as a diff). So the
// complete tailored document is just the base with each `original → tailored`
// applied — computed here at zero incremental AI cost (tailor-v2 §3, step T3).
//
// Three rules, matching the spec:
//   • replace the FIRST occurrence of `original` (indexOf is a literal search —
//     the resume has regex-special chars, so never build a RegExp from it);
//   • `original === ""` is new content → collected and appended under a clearly
//     marked block, because WHERE it goes is a human decision, not ours;
//   • an `original` the model quoted loosely (not found verbatim) goes in `failed`
//     — reported to the human, never silently swallowed.
// ---------------------------------------------------------------------------

/** The heading under which empty-`original` additions are appended for hand-placement. */
export const ADDITIONS_HEADER = "## Additions — place by hand";

export interface AssembleResult {
	text: string;
	applied: TailorEdit[];
	failed: TailorEdit[];
}

/**
 * Apply a reviewed draft's edits onto the base resume text. Pure and offline —
 * no AI, no I/O. Edits are applied in order; each `original → tailored` replaces
 * only the first verbatim occurrence. Empty-`original` edits are additions,
 * appended under {@link ADDITIONS_HEADER}. Edits whose `original` isn't found are
 * returned in `failed` (and left out of the text) rather than dropped silently.
 */
export function applyEdits(
	baseText: string,
	edits: TailorEdit[],
): AssembleResult {
	let text = baseText;
	const applied: TailorEdit[] = [];
	const failed: TailorEdit[] = [];
	const additions: TailorEdit[] = [];

	for (const edit of edits) {
		// New content: placement is a human call, so stage it for the additions block.
		if (edit.original === "") {
			additions.push(edit);
			applied.push(edit);
			continue;
		}

		const idx = text.indexOf(edit.original);
		if (idx === -1) {
			// Model quoted the resume loosely — report it, don't guess where it goes.
			failed.push(edit);
			continue;
		}

		text =
			text.slice(0, idx) +
			edit.tailored +
			text.slice(idx + edit.original.length);
		applied.push(edit);
	}

	if (additions.length > 0) {
		const block = additions
			.map((e) => `- (${e.section}) ${e.tailored}`)
			.join("\n");
		text = `${text}\n\n${ADDITIONS_HEADER}\n\n${block}\n`;
	}

	return { text, applied, failed };
}
