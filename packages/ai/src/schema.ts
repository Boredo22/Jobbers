import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// schema.ts — Zod → JSON Schema conversion, shared by all three providers.
//
// Every provider needs the same thing: turn the caller's Zod schema into JSON
// Schema. They use it two slightly different ways, so there are two exports:
//   • toStrictInputSchema — for the Messages API's *strict* forced tool use
//     (ApiProvider). Strict rejects a handful of JSON-Schema keywords, so we
//     strip them; our own Zod safeParse re-checks those values after the call.
//   • toJsonSchema — the FULL schema (bounds and all), embedded verbatim into the
//     prompt for the CLI / Cowork providers, which can't force tool use and must
//     instead *instruct* the model. There, the extra constraints are useful
//     guidance, not a problem — so we keep them.
// Extracting this here (out of providers/api.ts) is what keeps a second and third
// provider from re-deriving the conversion — one source of truth, three callers.
// ---------------------------------------------------------------------------

/**
 * JSON-Schema keywords that Anthropic *strict* tool use does not support
 * (numeric/length/array bounds). They're only advisory to the model anyway, and
 * our Zod safeParse still enforces them after the call, so stripping loses nothing.
 */
const STRICT_UNSUPPORTED = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
]);

function stripUnsupported(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) stripUnsupported(item);
		return;
	}
	if (node && typeof node === "object") {
		const obj = node as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			if (STRICT_UNSUPPORTED.has(key)) delete obj[key];
			else stripUnsupported(obj[key]);
		}
	}
}

/**
 * The full JSON Schema for a Zod schema, minus the `$schema` meta key. Used by the
 * CLI/Cowork providers, which embed it in the prompt as the shape to return. zod
 * v4 ships `z.toJSONSchema` natively — no third-party converter needed. The
 * `.describe()` strings survive the conversion, so they double as field hints.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema) as Record<string, unknown>;
	delete json.$schema;
	return json;
}

/**
 * The strict-tool-use variant: the full schema with the unsupported keywords
 * stripped, typed as the Messages API's `InputSchema`. Used by ApiProvider.
 */
export function toStrictInputSchema(
	schema: z.ZodType,
): Anthropic.Tool.InputSchema {
	const json = toJsonSchema(schema);
	stripUnsupported(json);
	// For an object schema `type` is "object", exactly what InputSchema requires.
	return json as Anthropic.Tool.InputSchema;
}
