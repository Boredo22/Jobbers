// ---------------------------------------------------------------------------
// prefilter.ts — the cheap gate before expensive LLM scoring.
//
// `isCandidate` is a PURE function: given a posting's title/location/remote, is
// it worth spending scoring tokens on? Keeping it pure (no I/O) makes it
// trivially unit-testable (convention §9.3) and keeps the poll runner readable.
//
// The keyword clusters are transcribed from the owner's JobFinder strategy
// (the AI-Enablement title cluster). The prefilter is intentionally *lenient*:
// it only drops the obvious non-fits (wrong title, or known-onsite far from the
// Capital Region). The LLM does the nuanced ranking in Phase 2.
// ---------------------------------------------------------------------------

// Titles we care about — the AI-Enablement / applied-AI / solutions / product
// / ops job family. A match on ANY of these (case-insensitive substring) is
// necessary to be a candidate.
const INCLUDE_TITLE_KEYWORDS = [
	"ai enablement",
	"ai transformation",
	"applied ai",
	"ai program",
	"ai product",
	"ai operations",
	"ai specialist",
	"ai lead",
	"ai engineer",
	"ai solutions",
	"machine learning product",
	"solutions engineer",
	"solutions architect",
	"solutions consultant",
	"forward deployed",
	"forward-deployed",
	"implementation",
	"product manager",
	"product operations",
	"technical product",
	"gtm engineer",
	"automation engineer",
	"prompt engineer",
	"technical account manager",
	"customer engineer",
	"sales engineer",
	"deployment",
	"deployment strategist",
	"value engineer",
	"value consultant",
	"program manager",
	"technical program",
	"professional services",
	"strategist",
	"operations manager",
	"operations lead",
	"business operations",
	"revenue operations",
	"enablement",
	"onboarding",
	"customer success engineer",
	"growth engineer",
	"technical consultant",
	"partner engineer",
	"field engineer",
	"solutions specialist",
	"delivery lead",
	"delivery manager",
	"generative ai",
	"genai",
	"agentic",
	"llm",
];

// Titles that disqualify outright even if an include keyword also matched
// (e.g. "Senior Software Engineer, AI" — the eng-IC track the owner avoids).
const EXCLUDE_TITLE_KEYWORDS = [
	"account executive",
	"sales development",
	"sdr ",
	"business development representative",
	"recruiter",
	"intern",
	"internship",
	"principal software engineer",
	"staff software engineer",
	"senior software engineer",
	"director of engineering",
	"vp of engineering",
	"accountant",
	"controller",
	"paralegal",
	"designer",
	"content marketing",
	"social media",
	"warehouse",
	"restaurant",
	"registered nurse",
	"truck driver",
];

// The owner's commutable area — the only place non-remote roles survive.
const CAPITAL_REGION =
	/(saratoga|stillwater|albany|schenectady|troy|clifton park|capital region|upstate new york)/i;

function containsAny(haystack: string, needles: string[]): boolean {
	return needles.some((n) => haystack.includes(n));
}

/** The posting fields the prefilter reads — a structural subset of a posting. */
export type PrefilterInput = {
	title: string;
	location: string | null;
	remote: boolean | null;
};

export function isCandidate(posting: PrefilterInput): boolean {
	const title = posting.title.toLowerCase();

	// Title gate: must hit the job family and dodge the disqualifiers.
	if (!containsAny(title, INCLUDE_TITLE_KEYWORDS)) return false;
	if (containsAny(title, EXCLUDE_TITLE_KEYWORDS)) return false;

	// Location gate: drop ONLY when we know it's not remote AND the location
	// isn't the Capital Region. Unknown remote (null) is kept — let the LLM
	// judge rather than discard on missing data.
	if (posting.remote === false) {
		return posting.location ? CAPITAL_REGION.test(posting.location) : false;
	}
	return true;
}
