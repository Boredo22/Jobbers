import { z } from "zod";
import type { AIProvider, AIRequest, AIResult, ModelTier } from "../provider";
import { toStrictInputSchema } from "../schema";

// ---------------------------------------------------------------------------
// OpenRouterProvider (Mode D) — one API key, hundreds of models.
//
// OpenRouter speaks the OpenAI-compatible chat-completions protocol, so this is
// the same forced-tool-call trick as ApiProvider translated to a different wire
// shape: declare one "function" tool whose parameters ARE our schema, force it
// with tool_choice, read the arguments back, Zod-validate, retry once with the
// errors fed in. Two differences worth knowing:
//   • `function.arguments` is a JSON *string* (Anthropic hands back an
//     already-parsed object), so there's an extra JSON.parse that can itself
//     fail — a parse failure is treated like a validation failure and consumes
//     the one retry.
//   • `provider: { require_parameters: true }` tells OpenRouter to only route
//     to upstream providers that actually honor `tools` — without it a request
//     can land somewhere that silently ignores tool_choice and returns prose.
//
// No OpenAI SDK: we need exactly one endpoint, and a fetch + a Zod schema for
// the response envelope is fewer deps and MORE validated than an SDK's loose
// types (CLAUDE.md §4: every external input crosses a Zod boundary — an HTTP
// body very much included).
// ---------------------------------------------------------------------------

export interface OpenRouterProviderOptions {
	/** The OpenRouter API key. Injected by the caller; never read from env here. */
	apiKey: string;
	/** Tier → OpenRouter model slug (e.g. "anthropic/claude-haiku-4.5"). */
	models: Record<ModelTier, string>;
	/** API base, overridable so tests can point fetch at a stub. */
	baseUrl?: string;
}

/**
 * The slice of the chat-completion envelope we actually consume, validated so a
 * malformed HTTP body is a loud error here, not an `undefined` five lines
 * later. `tool_calls` stays optional: despite the forced tool_choice a model
 * can still answer with prose, and that should burn the retry (a model-quality
 * problem), not throw as a broken envelope (a transport problem).
 */
const ChatCompletionSchema = z.object({
	model: z.string(),
	choices: z
		.array(
			z.object({
				message: z.object({
					tool_calls: z
						.array(z.object({ function: z.object({ arguments: z.string() }) }))
						.optional(),
				}),
			}),
		)
		.min(1),
	usage: z.object({
		prompt_tokens: z.number(),
		completion_tokens: z.number(),
		// Present because we send `usage: { include: true }` — the actual USD
		// charge, which the ledger prefers over its own estimate.
		cost: z.number().optional(),
	}),
});

export class OpenRouterProvider implements AIProvider {
	private readonly apiKey: string;
	private readonly models: Record<ModelTier, string>;
	private readonly baseUrl: string;

	constructor(opts: OpenRouterProviderOptions) {
		if (!opts.apiKey) {
			// Fail loudly at construction, not with a confusing 401 mid-scoring.
			throw new Error(
				"OpenRouterProvider requires an API key (set OPENROUTER_API_KEY).",
			);
		}
		this.apiKey = opts.apiKey;
		this.models = opts.models;
		this.baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
	}

	async complete<T>(req: AIRequest<T>): Promise<AIResult<T>> {
		const model = this.models[req.tier];
		const tool = {
			type: "function",
			function: {
				name: req.schemaName,
				description: `Return the result as structured ${req.schemaName} data.`,
				parameters: toStrictInputSchema(req.schema),
			},
		};

		const startedAt = Date.now();
		// Metering accumulates across attempts so the ai_runs ledger reflects the
		// true cost of getting a valid answer, including a retry.
		let inputTokens = 0;
		let outputTokens = 0;
		let costUsd: number | undefined;
		let lastModel = model;

		// Same two-attempt loop as ApiProvider: plain prompt first, then once more
		// with the validation errors appended; each attempt is a fresh single-turn
		// request.
		let prompt = req.prompt;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const res = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					// OpenRouter's attribution convention — shows up on their dashboard.
					"HTTP-Referer": "https://github.com/Boredo22/Jobbers",
					"X-Title": "Jobber",
				},
				body: JSON.stringify({
					model,
					max_tokens: req.maxTokens ?? 1024,
					messages: [{ role: "user", content: prompt }],
					tools: [tool],
					tool_choice: { type: "function", function: { name: req.schemaName } },
					provider: { require_parameters: true },
					usage: { include: true },
				}),
			});

			if (!res.ok) {
				// OpenRouter puts error detail in the JSON body — include it verbatim.
				const body = await res.text();
				throw new Error(
					`OpenRouterProvider: HTTP ${res.status} from ${model}: ${body}`,
				);
			}

			const envelope = ChatCompletionSchema.parse(await res.json());
			inputTokens += envelope.usage.prompt_tokens;
			outputTokens += envelope.usage.completion_tokens;
			if (envelope.usage.cost !== undefined) {
				costUsd = (costUsd ?? 0) + envelope.usage.cost;
			}
			lastModel = envelope.model;

			// arguments is a JSON string; a missing tool call or unparseable JSON is
			// the model failing the task, so it flows into the same retry path as a
			// schema miss rather than throwing immediately.
			let errors: string;
			const args =
				envelope.choices[0]?.message.tool_calls?.[0]?.function.arguments;
			if (args === undefined) {
				errors = `You must call the ${req.schemaName} tool — a plain text reply is not accepted.`;
			} else {
				let value: unknown;
				let jsonError: string | null = null;
				try {
					value = JSON.parse(args);
				} catch (e) {
					jsonError = e instanceof Error ? e.message : String(e);
				}
				if (jsonError !== null) {
					errors = `Tool arguments were not valid JSON: ${jsonError}`;
				} else {
					const parsed = req.schema.safeParse(value);
					if (parsed.success) {
						return {
							data: parsed.data,
							inputTokens,
							outputTokens,
							model: lastModel,
							durationMs: Date.now() - startedAt,
							costUsd,
						};
					}
					errors = z.prettifyError(parsed.error);
				}
			}

			if (attempt === 2) {
				throw new Error(
					`OpenRouterProvider: model output failed ${req.schemaName} validation after retry:\n${errors}`,
				);
			}
			prompt = `${req.prompt}\n\nYour previous response failed validation with these errors:\n${errors}\n\nReturn a corrected result that satisfies the schema.`;
		}

		// Unreachable — the loop either returns or throws — but the compiler needs it.
		throw new Error("OpenRouterProvider: exhausted attempts unexpectedly.");
	}
}
