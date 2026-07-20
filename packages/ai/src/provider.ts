import type { z } from "zod";

// ---------------------------------------------------------------------------
// provider.ts — the contract every AI backend implements.
//
// The whole point of packages/ai is to make "call an LLM and get back a value
// shaped like this Zod schema" a single, swappable operation. Three concrete
// providers will implement this interface over the project's life:
//   • ApiProvider    (Mode A) — the Anthropic Messages API directly   (step 2.2)
//   • CliProvider    (Mode B) — shells out to the `claude` CLI         (step 3.3)
//   • CoworkProvider (Mode C) — writes request files for a Cowork run  (step 3.3)
// The api's feature modules (scoring, resume review, …) depend only on this
// interface — they never import a concrete provider, so switching backends is a
// one-line config change, not a code change. Coming from Python, this is exactly
// a Protocol / ABC that several classes satisfy, dependency-injected at the edge.
//
// Design decision worth internalizing: the interface has ONE generic method,
// `complete`, not `scoreJob()` / `reviewResume()`. Features live in the api and
// pass their prompt + schema in. That keeps this package feature-agnostic — it
// knows nothing about jobs or resumes, only "text in, schema-shaped value out" —
// which is why the file-queue provider can be trivial: it just serializes the
// request. Bake feature logic in here and every provider would have to reimplement
// it three times.
// ---------------------------------------------------------------------------

/**
 * Which class of model to use. The interface deals in intent ("this is a cheap
 * bulk task" vs "this needs the strong model"), NOT concrete model IDs — those
 * are mapped to real names in config when a provider is built (step 2.2), so a
 * model rename is a config edit, never a change scattered through call sites.
 *   • "small" — bulk work where throughput/cost matters (scoring dozens of JDs)
 *   • "large" — quality-critical work (resume review, profile synthesis)
 */
export type ModelTier = "small" | "large";

/**
 * One request to an AI provider. `T` is inferred from `schema`, so the compiler
 * threads the output type all the way through: pass a `FitScoreSchema` and the
 * result's `.data` is typed `FitScore` with zero casts.
 */
export interface AIRequest<T> {
	/** The fully-rendered prompt text (templating already applied — step 2.3). */
	prompt: string;
	/**
	 * The Zod schema the model's output MUST satisfy. Providers convert it to a
	 * JSON Schema to force structured output, then `safeParse` the reply against
	 * it (validate-at-the-edge, CLAUDE.md §4) — an LLM that returns the wrong
	 * shape is a loud error, not a silent bad row.
	 */
	schema: z.ZodType<T>;
	/**
	 * A short identifier for the schema (e.g. "fit_score"). Used as the forced
	 * tool's name in the Messages API and as a label in logs. Distinct from the
	 * schema itself because JSON Schema conversion doesn't carry a name.
	 */
	schemaName: string;
	/** Upper bound on the model's reply length. Providers pick a sane default. */
	maxTokens?: number;
	/** Which model class to route to — see {@link ModelTier}. */
	tier: ModelTier;
}

/**
 * The result of a successful `complete` call: the validated value plus the
 * metering fields that make each call auditable. These map straight onto an
 * `ai_runs` row (feature, provider, model, tokens, duration, est. cost) — the
 * cost ledger that becomes the project's "I was cost-aware" interview story.
 */
export interface AIResult<T> {
	/** The model's output, already parsed and validated against the schema. */
	data: T;
	/** Tokens billed for the prompt (from the provider's usage report). */
	inputTokens: number;
	/** Tokens billed for the completion. */
	outputTokens: number;
	/** The concrete model ID that actually served the request. */
	model: string;
	/** Wall-clock time for the call, for the latency comparison in step 3.3. */
	durationMs: number;
}

/**
 * The one operation every backend implements. Callers depend on this type only.
 */
export interface AIProvider {
	complete<T>(req: AIRequest<T>): Promise<AIResult<T>>;
}
