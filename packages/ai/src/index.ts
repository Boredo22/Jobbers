// @jobber/ai — the pluggable AI provider layer.
//
// Public surface of the package. For now it's just the provider contract; the
// concrete providers (ApiProvider — step 2.2, CliProvider/CoworkProvider —
// step 3.3) and the prompt renderer (step 2.3) get re-exported from here as
// they land, so consumers always import from "@jobber/ai", never deep paths.
export type {
	AIProvider,
	AIRequest,
	AIResult,
	ModelTier,
} from "./provider";
