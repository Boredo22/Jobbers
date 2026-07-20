import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenRouterProvider } from "./openrouter";

// ---------------------------------------------------------------------------
// openrouter.test.ts — drives OpenRouterProvider against a stubbed global
// fetch (no network, no key spend). What's under test is the wire-shape
// handling this provider owns: envelope validation, the JSON-string arguments
// parse, the one-retry-with-errors loop, metering accumulation, and the
// provider-reported cost. The feature schemas themselves are tested elsewhere.
// ---------------------------------------------------------------------------

const Schema = z.object({ score: z.number().min(0).max(10), note: z.string() });

/** A minimal valid chat-completion envelope with the given tool arguments. */
function completion(
	args: string | null,
	usage = { prompt_tokens: 100, completion_tokens: 20, cost: 0.0005 },
) {
	return {
		model: "anthropic/claude-haiku-4.5",
		choices: [
			{
				message: {
					tool_calls:
						args === null ? undefined : [{ function: { arguments: args } }],
				},
			},
		],
		usage,
	};
}

/** Stub fetch to return each envelope (as a 200 JSON response) in order. */
function stubFetch(...bodies: unknown[]) {
	const mock = vi.fn();
	for (const body of bodies) {
		mock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), { status: 200 }),
		);
	}
	vi.stubGlobal("fetch", mock);
	return mock;
}

function makeProvider() {
	return new OpenRouterProvider({
		apiKey: "sk-or-test",
		models: { small: "anthropic/claude-haiku-4.5", large: "openai/gpt-5" },
	});
}

const request = {
	prompt: "Score this fake job.",
	schema: Schema,
	schemaName: "smoke",
	tier: "small" as const,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenRouterProvider", () => {
	it("returns parsed data, metering, and provider-reported cost", async () => {
		const mock = stubFetch(
			completion(JSON.stringify({ score: 8.5, note: "strong fit" })),
		);

		const res = await makeProvider().complete(request);
		expect(res.data).toEqual({ score: 8.5, note: "strong fit" });
		expect(res.inputTokens).toBe(100);
		expect(res.outputTokens).toBe(20);
		expect(res.model).toBe("anthropic/claude-haiku-4.5");
		expect(res.costUsd).toBeCloseTo(0.0005);

		// The request itself carries the forced tool call and usage accounting.
		const body = JSON.parse(mock.mock.calls[0]?.[1]?.body as string);
		expect(body.model).toBe("anthropic/claude-haiku-4.5");
		expect(body.tool_choice).toEqual({
			type: "function",
			function: { name: "smoke" },
		});
		expect(body.provider).toEqual({ require_parameters: true });
		expect(body.usage).toEqual({ include: true });
	});

	it("retries once with the validation errors and accumulates metering", async () => {
		const mock = stubFetch(
			completion(JSON.stringify({ score: 99, note: "out of range" })),
			completion(JSON.stringify({ score: 7, note: "fixed" }), {
				prompt_tokens: 150,
				completion_tokens: 30,
				cost: 0.0007,
			}),
		);

		const res = await makeProvider().complete(request);
		expect(res.data).toEqual({ score: 7, note: "fixed" });
		expect(res.inputTokens).toBe(250); // 100 + 150 across both attempts
		expect(res.outputTokens).toBe(50);
		expect(res.costUsd).toBeCloseTo(0.0012);

		// The second request's prompt carries the validation errors back.
		const retryBody = JSON.parse(mock.mock.calls[1]?.[1]?.body as string);
		expect(retryBody.messages[0].content).toContain("failed validation");
	});

	it("throws with the Zod errors when both attempts fail validation", async () => {
		stubFetch(
			completion(JSON.stringify({ score: 99, note: "bad" })),
			completion(JSON.stringify({ score: -1, note: "still bad" })),
		);

		await expect(makeProvider().complete(request)).rejects.toThrow(
			/failed smoke validation after retry/,
		);
	});

	it("treats malformed-JSON arguments as the one retry", async () => {
		const mock = stubFetch(
			completion("{not json"),
			completion(JSON.stringify({ score: 6, note: "recovered" })),
		);

		const res = await makeProvider().complete(request);
		expect(res.data).toEqual({ score: 6, note: "recovered" });
		expect(mock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse(mock.mock.calls[1]?.[1]?.body as string);
		expect(retryBody.messages[0].content).toContain("not valid JSON");
	});

	it("treats a missing tool call (prose reply) as the one retry", async () => {
		stubFetch(
			completion(null),
			completion(JSON.stringify({ score: 5, note: "called the tool" })),
		);

		const res = await makeProvider().complete(request);
		expect(res.data).toEqual({ score: 5, note: "called the tool" });
	});

	it("throws with status and body text on a non-2xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response('{"error":{"message":"insufficient credits"}}', {
					status: 402,
				}),
			),
		);

		await expect(makeProvider().complete(request)).rejects.toThrow(
			/HTTP 402.*insufficient credits/,
		);
	});

	it("fails loudly at construction without an API key", () => {
		expect(
			() =>
				new OpenRouterProvider({
					apiKey: "",
					models: { small: "a", large: "b" },
				}),
		).toThrow(/OPENROUTER_API_KEY/);
	});
});
