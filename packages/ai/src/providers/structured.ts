import { z } from "zod";
import type { AIRequest, AIResult } from "../provider";
import { toJsonSchema } from "../schema";

// ---------------------------------------------------------------------------
// structured.ts — shared "get schema-shaped output from a text-only backend".
//
// ApiProvider forces structured output with strict tool use. The CLI and Cowork
// providers can't do that — they only get text back — so they instead INSTRUCT
// the model with the JSON Schema and then parse the text. That parsing +
// validate + one-retry loop is identical for both, so it lives here once. Given a
// function that turns a prompt into text (`invoke`), runStructured owns the rest:
// build the instruction prompt, extract JSON, safeParse against the Zod schema,
// and on a miss retry once with the errors fed back — exactly ApiProvider's
// contract, so all three providers behave the same to their callers.
// ---------------------------------------------------------------------------

/** What a text backend returns for one call: the reply plus its metering. */
export interface TextResult {
	/** The model's raw text reply (may contain prose or ```json fences). */
	text: string;
	inputTokens: number;
	outputTokens: number;
	/** The concrete model id the backend reports, or a provider-specific label. */
	model: string;
}

/** Append the JSON-Schema contract to a prompt for a text-only backend. */
export function buildStructuredPrompt(req: AIRequest<unknown>): string {
	const schema = JSON.stringify(toJsonSchema(req.schema), null, 2);
	return `${req.prompt}

Respond with ONLY a single JSON object that conforms to this JSON Schema for "${req.schemaName}". No prose, no explanation, no markdown code fences — just the raw JSON object.

JSON Schema:
${schema}`;
}

/**
 * Pull the first JSON object out of a text reply. Text backends often wrap the
 * JSON in prose or ```json fences despite instructions, so we're forgiving:
 * strip fences, then take the first '{' … matching '}' span. Returns the parsed
 * value, or throws if no JSON object is present.
 */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = (fenced?.[1] ?? text).trim();

	// Fast path: the whole thing is JSON.
	try {
		return JSON.parse(body);
	} catch {
		// Fall through to bracket-matching.
	}

	// Scan for the first balanced {...} object, ignoring braces inside strings.
	const start = body.indexOf("{");
	if (start === -1) throw new Error("no JSON object found in model output");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < body.length; i++) {
		const ch = body[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			return JSON.parse(body.slice(start, i + 1));
		}
	}
	throw new Error("unterminated JSON object in model output");
}

/**
 * Run a structured request against a text backend. `invoke` does the actual work
 * (shell out, or file round-trip) and returns text + metering; this owns the
 * prompt construction, JSON extraction, Zod validation, and single retry — the
 * same reliability envelope ApiProvider gives, so a caller can't tell which
 * provider it got.
 */
export async function runStructured<T>(
	req: AIRequest<T>,
	invoke: (prompt: string) => Promise<TextResult>,
): Promise<AIResult<T>> {
	const startedAt = Date.now();
	let inputTokens = 0;
	let outputTokens = 0;
	let model = "";
	let prompt = buildStructuredPrompt(req);

	for (let attempt = 1; attempt <= 2; attempt++) {
		const res = await invoke(prompt);
		inputTokens += res.inputTokens;
		outputTokens += res.outputTokens;
		model = res.model;

		let parsed: z.ZodSafeParseResult<T>;
		try {
			parsed = req.schema.safeParse(extractJson(res.text));
		} catch (err) {
			// No parseable JSON at all — treat like a validation failure.
			parsed = {
				success: false,
				error: new z.ZodError([
					{
						code: "custom",
						path: [],
						message: err instanceof Error ? err.message : String(err),
						input: res.text,
					},
				]),
			} as z.ZodSafeParseResult<T>;
		}

		if (parsed.success) {
			return {
				data: parsed.data,
				inputTokens,
				outputTokens,
				model,
				durationMs: Date.now() - startedAt,
			};
		}

		const errors = z.prettifyError(parsed.error);
		if (attempt === 2) {
			throw new Error(
				`${req.schemaName}: model output failed validation after retry:\n${errors}`,
			);
		}
		prompt = `${buildStructuredPrompt(req)}

Your previous response failed validation with these errors:
${errors}

Return a corrected JSON object that satisfies the schema.`;
	}

	throw new Error("runStructured: exhausted attempts unexpectedly.");
}
