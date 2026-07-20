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
	// Analyst cluster — deliberately specific titles, not a bare "analyst",
	// which would drag in data/financial/security analyst roles.
	"business analyst",
	"systems analyst",
	"product analyst",
	"operations analyst",
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

// A location text that signals the role is actually remote / not tied to a
// specific office: an explicit "remote" (or synonyms) anywhere in the string,
// or a broad region rather than a city. Note "hybrid" deliberately has no entry
// here — a hybrid posting names a city and omits "remote", so it fails this
// test and is treated as onsite (see the location gate below).
const REMOTE_TOKENS =
	/\b(remote|anywhere|worldwide|global|nationwide|distributed)\b|north america|americas/i;
// The whole location is just a country (no city) → a nationwide, remote-eligible
// posting like a bare "United States". Anchored so "San Mateo, CA United States"
// (an office in San Mateo) does NOT match.
const COUNTRY_ONLY = /^\s*(united states|usa|u\.s\.a?\.?|us)\s*$/i;

function containsAny(haystack: string, needles: string[]): boolean {
	return needles.some((n) => haystack.includes(n));
}

// ---------------------------------------------------------------------------
// US-location detection — powers the "US only" toggle on /jobs.
//
// Location is free-text ("San Francisco, CA", "London, UK", "Remote, US",
// "Remote, Canada; Remote, US"). Like isCandidate this is a PURE function so
// it's cheap to reason about and test. Strategy, in order:
//   1. A positive US signal wins — even in a mixed string ("…Canada; Remote,
//      US" is US-eligible, keep it).
//   2. Otherwise a known non-US country/city means drop it.
//   3. Otherwise it's ambiguous ("Remote", "North America", null) — KEEP it.
//      We don't hide a posting on missing data; the goal is only to remove the
//      *known* non-US roles.
// ---------------------------------------------------------------------------

// State abbreviations only count in "City, ST" position (comma + space) so we
// never mistake the English words OR / IN / ME / HI for Oregon/Indiana/etc.
const US_STATE_ABBR =
	/,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;

// \bUS\b / \bUSA\b as whole words (won't fire inside "Belarus" or "Australia").
const US_COUNTRY = /\b(u\.?s\.?a?|united states)\b/i;

// Non-US country abbreviations, matched whole-word so "uk"/"uae"/"ksa" catch
// "London, UK" / "Remote, UAE" without firing inside longer words.
const NON_US_ABBR = /\b(uk|uae|ksa)\b/i;

// Full state names + the bare hub cities that show up without a state/country.
const US_TEXT = [
	"alabama",
	"alaska",
	"arizona",
	"arkansas",
	"california",
	"colorado",
	"connecticut",
	"delaware",
	"florida",
	"georgia",
	"idaho",
	"illinois",
	"indiana",
	"iowa",
	"kansas",
	"kentucky",
	"louisiana",
	"maine",
	"maryland",
	"massachusetts",
	"michigan",
	"minnesota",
	"mississippi",
	"missouri",
	"montana",
	"nebraska",
	"nevada",
	"new hampshire",
	"new jersey",
	"new mexico",
	"new york",
	"north carolina",
	"north dakota",
	"ohio",
	"oklahoma",
	"oregon",
	"pennsylvania",
	"rhode island",
	"south carolina",
	"south dakota",
	"tennessee",
	"texas",
	"utah",
	"vermont",
	"virginia",
	"washington",
	"west virginia",
	"wisconsin",
	"wyoming",
	"san francisco",
	" sf ",
	"nyc",
	"new york city",
	"los angeles",
	"chicago",
	"boston",
	"seattle",
	"austin",
	"denver",
	"atlanta",
	"dallas",
	"houston",
	"miami",
	"philadelphia",
	"san diego",
	"san jose",
	"palo alto",
	"mountain view",
	"menlo park",
	"sunnyvale",
];

// Known non-US countries + foreign cities that commonly appear with no country.
const NON_US_TEXT = [
	"canada",
	"mexico",
	"united kingdom",
	"england",
	"scotland",
	"wales",
	"ireland",
	"france",
	"germany",
	"spain",
	"portugal",
	"italy",
	"netherlands",
	"belgium",
	"switzerland",
	"austria",
	"sweden",
	"norway",
	"denmark",
	"finland",
	"poland",
	"czech",
	"serbia",
	"romania",
	"ukraine",
	"greece",
	"turkey",
	"israel",
	"india",
	"china",
	"japan",
	"korea",
	"singapore",
	"australia",
	"new zealand",
	"brazil",
	"argentina",
	"chile",
	"colombia",
	"philippines",
	"indonesia",
	"vietnam",
	"thailand",
	"malaysia",
	"egypt",
	"nigeria",
	"kenya",
	"south africa",
	"dubai",
	"saudi",
	"united arab emirates",
	"abu dhabi",
	"riyadh",
	"jeddah",
	"doha",
	"qatar",
	"pakistan",
	"bangladesh",
	"hong kong",
	"taiwan",
	"russia",
	"hungary",
	"bulgaria",
	"croatia",
	"slovakia",
	"slovenia",
	"lithuania",
	"latvia",
	"estonia",
	"iceland",
	"luxembourg",
	"remote - uk",
	"remote, uk",
	"london",
	"paris",
	"berlin",
	"munich",
	"amsterdam",
	"madrid",
	"barcelona",
	"dublin",
	"toronto",
	"vancouver",
	"montreal",
	"sydney",
	"melbourne",
	"tokyo",
	"seoul",
	"bengaluru",
	"bangalore",
	"hyderabad",
	"mumbai",
	"delhi",
	"pune",
	"chennai",
	"stockholm",
	"belgrade",
	"são paulo",
	"sao paulo",
	"tel aviv",
	"warsaw",
	"lisbon",
	"milan",
	"zurich",
	"geneva",
	"brussels",
	"copenhagen",
	"oslo",
	"helsinki",
	"prague",
	"vienna",
	"athens",
	"istanbul",
	"manila",
	"jakarta",
	"bangkok",
	"shanghai",
	"beijing",
	"shenzhen",
	"taipei",
	"mexico city",
];

/** Best-effort: does this free-text location place the role in the US? */
export function isUsLocation(location: string | null): boolean {
	if (!location) return true; // unknown → keep (don't hide on missing data)
	const s = location.toLowerCase();

	// 1. Any explicit US signal wins, even in a mixed multi-country string.
	if (US_STATE_ABBR.test(location)) return true;
	if (US_COUNTRY.test(location)) return true;
	if (containsAny(s, US_TEXT)) return true;

	// 2. A known non-US marker (and no US signal above) → not US.
	if (NON_US_ABBR.test(location)) return false;
	if (containsAny(s, NON_US_TEXT)) return false;

	// 3. Ambiguous ("Remote", "North America", "SF Office") → keep.
	return true;
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

	// Location gate. We judge viability from the location TEXT, not the upstream
	// `remote` flag: some boards tag hybrid, in-office roles as remote=true (e.g.
	// OpenAI's SF postings), so the flag can't be trusted to mean "work anywhere".
	// Keep a posting when it's commutable, explicitly remote, or nationwide; keep
	// unknown locations too (let the LLM judge). Everything else is a specific-city
	// (onsite or hybrid) role the owner can't take — drop it.
	const loc = posting.location;
	if (!loc) return true;
	if (CAPITAL_REGION.test(loc)) return true;
	if (REMOTE_TOKENS.test(loc) || COUNTRY_ONLY.test(loc)) return true;
	return false;
}
