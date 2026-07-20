import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AIRequest } from "../provider";
import {
	buildStructuredPrompt,
	extractJson,
	runStructured,
} from "./structured";

// ---------------------------------------------------------------------------
// structured.test.ts — the reliability layer the CLI and Cowork providers share.
// extractJson is the part most likely to bite (models wrap JSON in prose/fences),
// and runStructured owns the validate-and-retry envelope, so both pay rent here
// (CLAUDE.md §3). No network, no CLI — pure text in, parsed value out.
// ---------------------------------------------------------------------------

const Schema = z.object({ score: z.number().min(0).max(10), note: z.string() });
const req: AIRequest<z.infer<typeof Schema>> = {
	prompt: "Score it.",
	schema: Schema,
	schemaName: "smoke",
	tier: "small",
};

describe("extractJson", () => {
	it("parses a bare JSON object", () => {
		expect(extractJson('{"a":1}')).toEqual({ a: 1 });
	});

	it("parses JSON wrapped in a ```json fence", () => {
		const text = 'Here you go:\n```json\n{"a":1,"b":"x"}\n```\nThanks!';
		expect(extractJson(text)).toEqual({ a: 1, b: "x" });
	});

	it("parses JSON preceded by prose (bracket matching)", () => {
		const text =
			'Sure — the result is {"a":{"nested":true},"b":2} as requested.';
		expect(extractJson(text)).toEqual({ a: { nested: true }, b: 2 });
	});

	it("ignores braces inside string values", () => {
		const text = '{"note":"weights like {a} stay literal","ok":true}';
		expect(extractJson(text)).toEqual({
			note: "weights like {a} stay literal",
			ok: true,
		});
	});

	it("throws when there is no JSON object at all", () => {
		expect(() => extractJson("no json here")).toThrow();
	});
});

describe("buildStructuredPrompt", () => {
	it("embeds the schema name and keeps the base prompt", () => {
		const out = buildStructuredPrompt(req);
		expect(out).toContain("Score it.");
		expect(out).toContain("smoke");
		expect(out).toContain('"score"'); // the JSON Schema is inlined
	});
});

describe("runStructured", () => {
	it("returns validated data and threads metering through", async () => {
		const res = await runStructured(req, async () => ({
			text: '```json\n{"score":8.5,"note":"good"}\n```',
			inputTokens: 100,
			outputTokens: 20,
			model: "test-model",
		}));
		expect(res.data).toEqual({ score: 8.5, note: "good" });
		expect(res.inputTokens).toBe(100);
		expect(res.model).toBe("test-model");
		expect(res.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("retries once with errors fed back, then succeeds", async () => {
		const seen: string[] = [];
		let call = 0;
		const res = await runStructured(req, async (prompt) => {
			seen.push(prompt);
			call++;
			// First reply is invalid (score is a string); second is valid.
			return call === 1
				? {
						text: '{"score":"high","note":"x"}',
						inputTokens: 10,
						outputTokens: 5,
						model: "m",
					}
				: {
						text: '{"score":7,"note":"x"}',
						inputTokens: 10,
						outputTokens: 5,
						model: "m",
					};
		});
		expect(res.data.score).toBe(7);
		expect(call).toBe(2);
		// Tokens accumulate across the retry (true cost of getting a valid answer).
		expect(res.inputTokens).toBe(20);
		// The retry prompt carries the validation errors back to the model.
		expect(seen[1]).toContain("failed validation");
	});

	it("throws after a second invalid reply", async () => {
		await expect(
			runStructured(req, async () => ({
				text: "not json",
				inputTokens: 1,
				outputTokens: 1,
				model: "m",
			})),
		).rejects.toThrow(/failed validation after retry/);
	});
});
