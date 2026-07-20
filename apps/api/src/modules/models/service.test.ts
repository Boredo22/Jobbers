import { describe, expect, it } from "vitest";
import { mapCatalog } from "./service";

// ---------------------------------------------------------------------------
// service.test.ts — the raw-catalog → lean-shape mapper, against a fixture
// modeled on the real /api/v1/models response (extra fields included on
// purpose: Zod strips what we don't declare). The cache/fetch wrapper is thin
// enough that the manual checkpoint covers it.
// ---------------------------------------------------------------------------

/** Trimmed-down real response: prices are strings in USD per *single* token. */
const fixture = {
	data: [
		{
			id: "anthropic/claude-haiku-4.5",
			canonical_slug: "anthropic/claude-4.5-haiku-20251001",
			name: "Anthropic: Claude Haiku 4.5",
			context_length: 200000,
			architecture: { modality: "text+image->text" },
			pricing: {
				prompt: "0.000001",
				completion: "0.000005",
				web_search: "0.01",
			},
			supported_parameters: ["max_tokens", "tools", "tool_choice"],
		},
		{
			// No "tools" in supported_parameters → must be filtered out.
			id: "prose/only-model",
			name: "Prose Only",
			context_length: 8192,
			pricing: { prompt: "0.0000001", completion: "0.0000002" },
			supported_parameters: ["max_tokens", "temperature"],
		},
		{
			// Missing supported_parameters entirely → also filtered out.
			id: "mystery/no-params",
			name: "No Params Declared",
			context_length: null,
			pricing: { prompt: "0", completion: "0" },
		},
		{
			id: "deepseek/deepseek-chat",
			name: "DeepSeek: DeepSeek V3",
			context_length: null,
			pricing: { prompt: "0.00000025", completion: "0.00000085" },
			supported_parameters: ["tools", "tool_choice"],
		},
	],
};

describe("mapCatalog", () => {
	it("keeps only tools-capable models, converts prices to per-MTok, sorts by slug", () => {
		const models = mapCatalog(fixture);

		expect(models.map((m) => m.id)).toEqual([
			"anthropic/claude-haiku-4.5", // sorted ahead of deepseek
			"deepseek/deepseek-chat",
		]);

		const [haiku, deepseek] = models;
		// "0.000001"/token → exactly $1 per MTok (the round kills IEEE 754 noise).
		expect(haiku?.promptPerMTok).toBe(1);
		expect(haiku?.completionPerMTok).toBe(5);
		expect(haiku?.contextLength).toBe(200000);
		expect(deepseek?.promptPerMTok).toBe(0.25);
		expect(deepseek?.completionPerMTok).toBe(0.85);
		expect(deepseek?.contextLength).toBeNull();
	});

	it("rejects a malformed catalog loudly", () => {
		expect(() => mapCatalog({ data: [{ id: 42 }] })).toThrow();
		expect(() =>
			mapCatalog({
				data: [
					{
						id: "bad/price",
						name: "Bad Price",
						context_length: 1,
						pricing: { prompt: "not-a-number", completion: "0" },
						supported_parameters: ["tools"],
					},
				],
			}),
		).toThrow();
	});
});
