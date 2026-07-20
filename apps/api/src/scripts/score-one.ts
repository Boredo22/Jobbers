import { FitScoreSchema } from "@jobber/shared";
import { queryClient } from "../db/client";
import { createProvider, logAiRun } from "../lib/ai";

// ---------------------------------------------------------------------------
// score-one.ts — the step 2.2 checkpoint. Scores ONE hardcoded job description
// against a tiny inline profile, proving the whole Mode A path end to end:
// prompt → forced tool use → schema-validated FitScore → ai_runs ledger row.
//
// Run:  pnpm --filter api score:one   (needs ANTHROPIC_API_KEY in .env)
//
// The prompt here is inline and minimal on purpose — versioned prompt FILES and
// the real profile/resume assembly arrive in steps 2.3–2.4. This script exists
// only to exercise the provider and confirm sane token counts land in ai_runs.
// ---------------------------------------------------------------------------

const CANDIDATE = `
Candidate summary: Backend/data engineer, ~4 years, strong Python (Flask/FastAPI),
Postgres, Docker; currently learning TypeScript/React. Wants remote, IC role,
comp floor ~$140k. No CS degree. Interested in AI-enablement / applied-AI work.
`.trim();

const JOB = `
Title: AI Solutions Engineer (Remote, US)
Company: Acme AI
We're hiring an engineer to build LLM-powered internal tools. You'll ship Python
services, integrate model APIs, and partner with product to turn workflows into
agents. Remote-first. Comp: $150k–$190k + equity. Nice to have: TypeScript,
Postgres. No degree requirement — we hire for demonstrated ability.
`.trim();

const PROMPT = `You are screening a job posting for a specific candidate. Score how well
the ROLE fits the CANDIDATE using the fit_score tool. Be calibrated: 5 = plausible
with real gaps, 8 = strong match worth applying to today, 10 = near-perfect. Flag a
credential gap only if the posting hard-requires something the candidate lacks.

CANDIDATE:
${CANDIDATE}

JOB POSTING:
${JOB}`;

async function main() {
	const provider = createProvider();

	const result = await provider.complete({
		prompt: PROMPT,
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
