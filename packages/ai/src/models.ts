import type { ModelTier } from "./provider";

// ---------------------------------------------------------------------------
// models.ts — the single place that maps abstract tiers → concrete model IDs,
// and model IDs → prices. Everything volatile about "which model, what does it
// cost" lives here, so a model rename or a price change is a one-file edit and
// never leaks into call sites. Same instinct as the api's env gateway: push the
// facts that change to one edge and keep the core stable.
//
// Model IDs and per-million-token prices are transcribed from the Anthropic
// models/pricing reference (checked at build time — do not guess these). If a
// model is renamed or repriced, update this table and nothing else moves.
// ---------------------------------------------------------------------------

/**
 * Tier → concrete model ID.
 *   • small — bulk scoring: cheap and fast (Haiku).
 *   • large — quality-critical work (resume review, profile synthesis): Sonnet.
 * The scorer asks for "small"; it never names a model.
 */
export const MODELS: Record<ModelTier, string> = {
	small: "claude-haiku-4-5",
	large: "claude-sonnet-5",
};

/**
 * Tier → OpenRouter model slug, used when AI_PROVIDER=openrouter and no
 * tier→model setting has been saved yet (step M3). Deliberately the OpenRouter
 * spellings of the same two models as MODELS above — note the dots vs. dashes
 * ("claude-haiku-4.5", not "claude-haiku-4-5") — so first run behaves exactly
 * like Mode A. Slugs verified against https://openrouter.ai/api/v1/models.
 */
export const OPENROUTER_DEFAULT_MODELS: Record<ModelTier, string> = {
	small: "anthropic/claude-haiku-4.5",
	large: "anthropic/claude-sonnet-5",
};

/** USD per 1,000,000 tokens, per model. Used to estimate each run's cost. */
type Price = { input: number; output: number };
export const PRICING: Record<string, Price> = {
	// $1.00 in / $5.00 out per MTok.
	"claude-haiku-4-5": { input: 1.0, output: 5.0 },
	// Standard sticker $3.00 in / $15.00 out per MTok. (An intro discount runs
	// through 2026-08-31; we bill the ledger at the sticker rate so the estimate
	// never *under*-reports — a conservative cost story is the safe one.)
	"claude-sonnet-5": { input: 3.0, output: 15.0 },
};

/**
 * Look up a model's price, tolerating dated snapshots. We send the alias
 * ("claude-haiku-4-5") but the API reports the concrete snapshot it served
 * ("claude-haiku-4-5-20251001"), so an exact-key lookup misses. Match the alias
 * that is a prefix of the returned id, which is robust to the date suffix
 * changing. Returns null for a genuinely unknown model.
 */
function priceFor(model: string): Price | null {
	if (PRICING[model]) return PRICING[model];
	for (const [alias, price] of Object.entries(PRICING)) {
		if (model.startsWith(`${alias}-`)) return price;
	}
	return null;
}

/**
 * Estimate the USD cost of one call. Returns null when the model isn't in the
 * price table (an unknown model shouldn't be silently priced at $0 — a null
 * lets the caller store NULL in ai_runs.est_cost rather than a wrong number).
 */
export function estimateCostUsd(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number | null {
	const price = priceFor(model);
	if (!price) return null;
	return (
		(inputTokens / 1_000_000) * price.input +
		(outputTokens / 1_000_000) * price.output
	);
}
