import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODELS } from "../models";
import type { AIProvider, AIRequest, AIResult } from "../provider";
import { toStrictInputSchema } from "../schema";

// ---------------------------------------------------------------------------
// ApiProvider (Mode A) — talk to the Anthropic Messages API directly.
//
// The one hard problem this solves: getting the model to return a value shaped
// exactly like a Zod schema, reliably. The trick is FORCED TOOL USE. We declare
// a single "tool" whose input_schema IS our schema (converted to JSON Schema),
// then set tool_choice to force the model to "call" it. The model can't reply
// with prose — it must emit a tool_use block whose `input` matches the schema.
// We read that input back, validate it with the same Zod schema (belt and
// suspenders — the model can still fudge a constraint), and on a miss we retry
// once with the validation errors fed back in. This is the reliable pattern for
// structured output; native structured outputs exist too, but forced tool use
// is the most forgiving of rich schemas (min/max, descriptions) without the
// strict-JSON-Schema limitations, so we use it here.
//
// The class is constructed with its API key injected (from the api's env
// gateway) — packages/ai never reads process.env itself, keeping it a pure,
// testable library. Coming from Python, this is a class implementing a Protocol,
// dependency-injected at the composition root.
// ---------------------------------------------------------------------------

export interface ApiProviderOptions {
	/** The Anthropic API key. Injected by the caller; never read from env here. */
	apiKey: string;
	/** Override the tier→model map (tests, experiments). Defaults to MODELS. */
	models?: typeof MODELS;
}

export class ApiProvider implements AIProvider {
	private readonly client: Anthropic;
	private readonly models: typeof MODELS;

	constructor(opts: ApiProviderOptions) {
		if (!opts.apiKey) {
			// Fail loudly at construction, not with a confusing 401 mid-scoring.
			throw new Error(
				"ApiProvider requires an Anthropic API key (set ANTHROPIC_API_KEY).",
			);
		}
		this.client = new Anthropic({ apiKey: opts.apiKey });
		this.models = opts.models ?? MODELS;
	}

	async complete<T>(req: AIRequest<T>): Promise<AIResult<T>> {
		const model = this.models[req.tier];
		const tool: Anthropic.Tool = {
			name: req.schemaName,
			description: `Return the result as structured ${req.schemaName} data.`,
			input_schema: toStrictInputSchema(req.schema),
			// Strict tool use GUARANTEES the arguments validate against the schema —
			// the model can't collapse an array into a string or drop a field the way
			// plain (guided) tool use can. This is what makes structured output
			// reliable across free-form tasks like resume review, not just the ones
			// the model happens to comply with. Requires additionalProperties:false +
			// required (z.toJSONSchema emits both) and the keyword strip above.
			strict: true,
		};

		const startedAt = Date.now();
		// Metering accumulates across attempts so the ai_runs ledger reflects the
		// true cost of getting a valid answer, including a retry.
		let inputTokens = 0;
		let outputTokens = 0;
		let lastModel = model;

		// Up to two attempts: the first from the plain prompt, the second with the
		// validation errors appended. We re-issue a fresh single-turn request (not
		// a tool_result continuation) so we never have to satisfy the API's
		// tool_use/tool_result pairing rules — simpler and just as effective.
		let prompt = req.prompt;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const res = await this.client.messages.create({
				model,
				max_tokens: req.maxTokens ?? 1024,
				tools: [tool],
				tool_choice: { type: "tool", name: req.schemaName },
				messages: [{ role: "user", content: prompt }],
			});

			inputTokens += res.usage.input_tokens;
			outputTokens += res.usage.output_tokens;
			lastModel = res.model;

			// Forced tool_choice guarantees a tool_use block; find it and validate.
			const block = res.content.find((b) => b.type === "tool_use");
			const parsed = req.schema.safeParse(block?.input);
			if (parsed.success) {
				return {
					data: parsed.data,
					inputTokens,
					outputTokens,
					model: lastModel,
					durationMs: Date.now() - startedAt,
				};
			}

			// Feed the exact validation errors back for the one retry, then give up.
			const errors = z.prettifyError(parsed.error);
			if (attempt === 2) {
				throw new Error(
					`ApiProvider: model output failed ${req.schemaName} validation after retry:\n${errors}`,
				);
			}
			prompt = `${req.prompt}\n\nYour previous response failed validation with these errors:\n${errors}\n\nReturn a corrected result that satisfies the schema.`;
		}

		// Unreachable — the loop either returns or throws — but the compiler needs it.
		throw new Error("ApiProvider: exhausted attempts unexpectedly.");
	}
}
