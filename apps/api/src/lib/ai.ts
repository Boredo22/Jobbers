import {
	type AIProvider,
	type AIResult,
	ApiProvider,
	estimateCostUsd,
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
 * abstraction): today only "api" (Mode A) exists; "cli"/"cowork" land in
 * Phase 3 and slot in here without touching any caller.
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
		default:
			// cli / cowork arrive in Phase 3 (step 3.3).
			throw new Error(`AI_PROVIDER "${env.AI_PROVIDER}" not implemented yet.`);
	}
}

/** Which product feature made the call — matches the ai_runs.feature enum. */
type AiFeature = "score" | "resume_review" | "profile";

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
	const cost = estimateCostUsd(
		result.model,
		result.inputTokens,
		result.outputTokens,
	);
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
