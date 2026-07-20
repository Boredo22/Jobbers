// ---------------------------------------------------------------------------
// scan.ts — pull the job description text out of whatever page we're on.
//
// This is heuristic by design. Every ATS renders differently, so instead of
// per-site adapters the strategy is layered:
//   1. If the user selected text, that wins — it's the human saying "this is
//      the JD". (Best results on noisy pages.)
//   2. Try increasingly generic containers (description divs → <article> →
//      <main>) and take the first tier that yields a substantial block.
//   3. Fall back to the whole body.
// The API-side prompt is told the scan may include site chrome, so a noisy
// grab degrades quality gracefully instead of failing.
// ---------------------------------------------------------------------------

// Matches the CoverLetterRequestSchema bound — clamp before shipping.
const MAX_CHARS = 30_000;
// Below this a "description" container is probably a teaser/snippet, not the JD.
const SUBSTANTIAL = 400;

// Ordered most-specific → most-generic. Within a tier the longest text wins;
// across tiers the FIRST tier with a substantial hit wins, so a tight
// job-description div beats <main> even though <main> has more text.
const TIERS: string[][] = [
	[
		'[class*="job-desc" i]',
		'[class*="jobdesc" i]',
		'[id*="job-desc" i]',
		'[data-qa*="description" i]',
		'[data-testid*="description" i]',
		'[class*="description" i]',
		'[id*="description" i]',
	],
	["article", '[role="main"]', "main"],
];

export interface ScanResult {
	text: string;
	/** Where the text came from — shown in the sidebar so a bad scan is legible. */
	source: "selection" | "container" | "page";
}

export function scanJobText(doc: Document): ScanResult {
	const selection = doc.getSelection()?.toString().trim() ?? "";
	if (selection.length >= 80) {
		return { text: clamp(selection), source: "selection" };
	}

	for (const tier of TIERS) {
		let best = "";
		for (const selector of tier) {
			for (const el of doc.querySelectorAll<HTMLElement>(selector)) {
				// innerText (not textContent): it respects CSS visibility and
				// line breaks, so hidden templates/scripts don't pollute the scan.
				const text = el.innerText?.trim() ?? "";
				if (text.length > best.length) best = text;
			}
		}
		if (best.length >= SUBSTANTIAL) {
			return { text: clamp(best), source: "container" };
		}
	}

	return { text: clamp(doc.body?.innerText?.trim() ?? ""), source: "page" };
}

function clamp(text: string): string {
	return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}
