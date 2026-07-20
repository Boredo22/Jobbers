import type {
	ModelsCatalog,
	ModelUsageRow,
	OpenRouterModel,
} from "@jobber/shared";
import { count, desc, max, sum } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { aiRuns } from "../../db/schema";

// ---------------------------------------------------------------------------
// models/service.ts — fetch + cache the public OpenRouter model catalog.
//
// The catalog is fetched live, never hardcoded: ~340 models with pricing that
// changes under us. It's public (no key), so the only jobs here are (1) put the
// response through a Zod boundary, (2) trim it to the lean shape the UI needs,
// (3) filter to models that can actually serve our forced-tool-call pattern,
// and (4) not hammer OpenRouter — one fetch an hour, serving stale on a failed
// refetch (a job dashboard would rather show hour-old prices than a 502).
// ---------------------------------------------------------------------------

/**
 * The slice of the raw catalog we consume. Prices arrive as *strings* in USD
 * per single token ("0.000001"); z.coerce.number() makes a non-numeric string
 * a loud validation error rather than a NaN that renders as $NaN in the UI.
 * supported_parameters is nullish-tolerant: a model that doesn't declare its
 * parameters can't promise `tools`, so it simply gets filtered out.
 */
const RawCatalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			context_length: z.number().nullable(),
			pricing: z.object({
				prompt: z.coerce.number(),
				completion: z.coerce.number(),
			}),
			supported_parameters: z.array(z.string()).nullish(),
		}),
	),
});

/** USD/token → USD/MTok, rounded to kill float noise (0.000001×1e6 ≠ 1.0 in IEEE 754). */
function perMTok(perToken: number): number {
	return Number((perToken * 1e6).toFixed(4));
}

/**
 * Validate the raw catalog and map it to the shared shape: tools-capable
 * models only (our structured output is a forced tool call — a model without
 * `tools` support would return prose and burn retries), sorted by slug so the
 * list is stable across refetches.
 */
export function mapCatalog(raw: unknown): OpenRouterModel[] {
	return RawCatalogSchema.parse(raw)
		.data.filter((m) => (m.supported_parameters ?? []).includes("tools"))
		.map((m) => ({
			id: m.id,
			name: m.name,
			contextLength: m.context_length,
			promptPerMTok: perMTok(m.pricing.prompt),
			completionPerMTok: perMTok(m.pricing.completion),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The first tier slug that isn't in the catalog, or null when both are fine.
 * The catalog is already filtered to tools-capable models, so one membership
 * check covers both "no such model" and "model can't do forced tool calls".
 */
export function findUnknownSlug(
	settings: { small: string; large: string },
	models: OpenRouterModel[],
): string | null {
	const ids = new Set(models.map((m) => m.id));
	if (!ids.has(settings.small)) return settings.small;
	if (!ids.has(settings.large)) return settings.large;
	return null;
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

// Module-level cache: one entry, process lifetime. Module state as a singleton
// cache is idiomatic here for the same reason a module-level dict works in
// Python — the module is only evaluated once per process.
let cache: { catalog: ModelsCatalog; fetchedAtMs: number } | null = null;

/**
 * The current catalog, from cache when fresh. On a refetch failure, stale
 * data beats no data; with an empty cache the error propagates (routes → 502).
 */
export async function getCatalog(): Promise<ModelsCatalog> {
	if (cache && Date.now() - cache.fetchedAtMs < CATALOG_TTL_MS) {
		return cache.catalog;
	}
	try {
		const res = await fetch(CATALOG_URL);
		if (!res.ok) {
			throw new Error(`OpenRouter catalog fetch failed: HTTP ${res.status}`);
		}
		const models = mapCatalog(await res.json());
		cache = {
			catalog: { models, fetchedAt: new Date().toISOString() },
			fetchedAtMs: Date.now(),
		};
		return cache.catalog;
	} catch (err) {
		if (cache) return cache.catalog;
		throw err;
	}
}

/**
 * Actual spend per model from the ai_runs ledger, newest-used first — the
 * "what did my choice really cost" half of the AI Models page. SQL aggregates
 * of numeric/bigint come back from Drizzle as *strings* (exactness over
 * convenience — same reason est_cost is numeric), so everything numeric is
 * parsed here at the boundary rather than in a React component.
 */
export async function getModelUsage(): Promise<ModelUsageRow[]> {
	const lastUsed = max(aiRuns.createdAt);
	const rows = await db
		.select({
			model: aiRuns.model,
			calls: count(),
			inputTokens: sum(aiRuns.inputTokens),
			outputTokens: sum(aiRuns.outputTokens),
			totalCost: sum(aiRuns.estCost),
			lastUsedAt: lastUsed,
		})
		.from(aiRuns)
		.groupBy(aiRuns.model)
		.orderBy(desc(lastUsed));
	return rows.map((r) => ({
		model: r.model,
		calls: r.calls,
		inputTokens: Number(r.inputTokens ?? 0),
		outputTokens: Number(r.outputTokens ?? 0),
		// SUM of an all-NULL group is NULL — keep it null, don't fake a $0.
		totalCostUsd: r.totalCost === null ? null : Number(r.totalCost),
		lastUsedAt: (r.lastUsedAt ?? new Date(0)).toISOString(),
	}));
}
