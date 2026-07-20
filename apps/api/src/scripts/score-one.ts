import { renderPrompt, SCORE_JOB_PROMPT } from "@jobber/ai";
import { FitScoreSchema } from "@jobber/shared";
import { queryClient } from "../db/client";
import { createProvider, logAiRun } from "../lib/ai";

// ---------------------------------------------------------------------------
// score-one.ts — the step 2.2 checkpoint, upgraded in 2.3 to render the prompt
// from the versioned file instead of an inline string. Proves the whole Mode A
// path end to end: file-based prompt → forced tool use → schema-validated
// FitScore → ai_runs ledger row.
//
// Run:  pnpm --filter api score:one   (needs ANTHROPIC_API_KEY in .env)
//
// The profile/resume/jd fixtures below stand in for the real active
// profile/resume assembly, which the scoring module wires up in step 2.4.
// ---------------------------------------------------------------------------

const PROFILE = `
Aiming for a remote, individual-contributor engineering role in applied AI /
AI-enablement. Hard constraints: remote required; comp floor ~$140k. No CS degree.
`.trim();

const RESUME = `
Backend/data engineer, ~4 years. Strong Python (Flask/FastAPI), Postgres, Docker.
Shipped internal data services and ETL. Currently learning TypeScript/React.
`.trim();

const JD = `
Title: AI Solutions Engineer (Remote, US)
Company: Acme AI
We're hiring an engineer to build LLM-powered internal tools. You'll ship Python
services, integrate model APIs, and partner with product to turn workflows into
agents. Remote-first. Comp: $150k–$190k + equity. Nice to have: TypeScript,
Postgres. No degree requirement — we hire for demonstrated ability.
`.trim();

async function main() {
	const provider = await createProvider();

	// Render the versioned scoring prompt with the fixtures filled in.
	const prompt = renderPrompt(SCORE_JOB_PROMPT, {
		profile: PROFILE,
		resume: RESUME,
		jd: JD,
	});

	const result = await provider.complete({
		prompt,
		schema: FitScoreSchema,
		schemaName: "fit_score",
		tier: "small",
		maxTokens: 1024,
	});

	// Persist the cost/audit row, then show what came back.
	await logAiRun("score", result);

	console.log("\n=== FitScore ===");
	console.log(JSON.stringify(result.data, null, 2));
	console.log("\n=== Metering (logged to ai_runs) ===");
	console.log(
		`model=${result.model}  in=${result.inputTokens}tok  out=${result.outputTokens}tok  ${result.durationMs}ms`,
	);
}

try {
	await main();
} catch (err) {
	console.error("score-one failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
