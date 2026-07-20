// @jobber/ai — the pluggable AI provider layer.
//
// Public surface of the package. Consumers import everything from "@jobber/ai",
// never from deep paths, so internals stay free to move.

export { estimateCostUsd, MODELS, PRICING } from "./models";
export { promptVersion, renderPrompt, SCORE_JOB_PROMPT } from "./prompts";
export type {
	AIProvider,
	AIRequest,
	AIResult,
	ModelTier,
} from "./provider";
export { ApiProvider, type ApiProviderOptions } from "./providers/api";
