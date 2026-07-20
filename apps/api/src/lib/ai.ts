import { resolve } from "node:path";
import {
	type AIProvider,
	type AIResult,
	ApiProvider,
	CliProvider,
	CoworkProvider,
	estimateCostUsd,
	OPENROUTER_DEFAULT_MODELS,
	OpenRouterProvider,
} from "@jobber/ai";
import { db } from "../db/client";
import { aiRuns } from "../db/schema";
import { env } from "./config";

// ---------------------------------------------------------------------------
// lib/ai.ts — the api's composition root for the AI layer.
//
// packages/ai is a pure, env-agnostic library: it knows how to call a model but
// nothing about *this* app's config or database. This file is where the two
// meet — it reads the validated env, builds the concrete provider, and owns the
// ai_runs ledger write. Keeping that here (not in packages/ai) is what lets the
// AI package stay testable and reusable.
// ---------------------------------------------------------------------------

/**
 * Build the configured AI provider. Driven by AI_PROVIDER (step 2.1's
 * abstraction): "api" (Mode A) hits Anthropic directly; "cli" (Mode B) shells out
 * to the `claude` CLI; "cowork" (Mode C) exchanges files with a Cowork session.
 * Every caller depends only on the AIProvider interface, so this switch is the
 * ONLY place that knows which backend is live — swapping is a one-env-var change.
 */
export function createProvider(): AIProvider {
	switch (env.AI_PROVIDER) {
		case "api": {
			if (!env.ANTHROPIC_API_KEY) {
				throw new Error(
					"AI_PROVIDER=api requires ANTHROPIC_API_KEY in .env (see .env.example).",
				);
			}
			return new ApiProvider({ apiKey: env.ANTHROPIC_API_KEY });
		}
		case "cli":
			// No API key needed — runs against the logged-in Claude Code CLI.
			return new CliProvider({ claudeBin: env.CLAUDE_BIN });
		case "cowork":
			// No API key needed — a Cowork session answers the file queue.
			return new CoworkProvider({ queueDir: resolve(env.AI_QUEUE_DIR) });
		case "openrouter": {
			if (!env.OPENROUTER_API_KEY) {
				throw new Error(
					"AI_PROVIDER=openrouter requires OPENROUTER_API_KEY in .env (see .env.example).",
				);
			}
			// Tier→model is the fixed defaults for now; step M3 makes it DB-driven.
			return new OpenRouterProvider({
				apiKey: env.OPENROUTER_API_KEY,
				models: OPENROUTER_DEFAULT_MODELS,
			});
		}
	}
}

/** Which product feature made the call — matches the ai_runs.feature enum. */
type AiFeature =
	| "score"
	| "resume_review"
	| "profile"
	| "tailor"
	| "cover_letter";

/**
 * Record one AI call in the ai_runs cost/audit ledger. The provider returns the
 * metering (tokens, model, duration); we add the feature label and the estimated
 * dollar cost from the price table. Returning the row lets callers log/inspect it.
 *
 * numeric columns take a *string* in Drizzle (money stays exact — no float cents),
 * so estCost is formatted to 6 decimals; an unknown model yields null cost rather
 * than a fabricated $0.
 */
export async function logAiRun(
	feature: AiFeature,
	result: AIResult<unknown>,
): Promise<void> {
	// Prefer the provider-reported charge (OpenRouter's usage.cost — the real
	// bill) over our own estimate; the PRICING-table estimate remains the
	// fallback for backends that can't report one.
	const cost =
		result.costUsd ??
		estimateCostUsd(result.model, result.inputTokens, result.outputTokens);
	await db.insert(aiRuns).values({
		feature,
		provider: env.AI_PROVIDER,
		model: result.model,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		estCost: cost === null ? null : cost.toFixed(6),
		durationMs: result.durationMs,
	});
}
