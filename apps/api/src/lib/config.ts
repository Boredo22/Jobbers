import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// config — the single, validated gateway for environment variables.
//
// Convention (CLAUDE.md §4): *every external input crosses a Zod boundary*.
// Env vars are external input, so they get the same treatment as an HTTP body:
// parse them once, here, and the rest of the codebase imports a typed `env`
// object that is guaranteed to be complete. A missing DATABASE_URL fails loudly
// at startup instead of surfacing as a mysterious `undefined` deep in the DB
// driver. Think of this file as pydantic-settings for Node.
// ---------------------------------------------------------------------------

/**
 * The `.env` file lives at the monorepo root, but these commands run with their
 * working directory set to `apps/api` (pnpm --filter) or wherever drizzle-kit
 * bundles the config. Rather than hardcode a brittle `../../.env`, walk up from
 * the current directory until we find it. Returns undefined if none exists —
 * that's fine when the vars are already set in the real environment (Docker).
 */
function findEnvFile(): string | undefined {
	let dir = process.cwd();
	for (let i = 0; i < 6; i++) {
		const candidate = resolve(dir, ".env");
		if (existsSync(candidate)) return candidate;
		const parent = resolve(dir, "..");
		if (parent === dir) break; // reached the filesystem root
		dir = parent;
	}
	return undefined;
}

// Node 22 can read a .env file natively (like python-dotenv, but built in).
// Skip it if the var is already present (e.g. injected by Docker Compose).
if (!process.env.DATABASE_URL) {
	const envFile = findEnvFile();
	if (envFile) process.loadEnvFile(envFile);
}

/**
 * Treat an empty-string env value as "unset". Docker Compose's `env_file`
 * passes blank lines like `NTFY_URL=` through as "" (unlike a plain shell,
 * where the var simply wouldn't exist) — without this, "" would fail
 * z.string().url() at startup even though the intent was clearly "no ntfy".
 */
const emptyAsUndefined = (v: unknown) => (v === "" ? undefined : v);

const EnvSchema = z.object({
	// The postgres.js connection string, e.g.
	// postgres://jobber:<password>@localhost:5432/jobber
	DATABASE_URL: z.string().url(),

	// ntfy topic URL for push notifications (step 1.5), e.g.
	// https://ntfy.sh/jobber-<random>. Optional: leave it unset and notify()
	// becomes a no-op, so the poller runs fine on a machine with no phone
	// attached. When set it must be a real URL (validated, not silently ignored).
	NTFY_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),

	// Whether the in-process cron scheduler arms itself on boot (step 1.5).
	// Off by default so `tsx watch` restarts and one-off scripts don't quietly
	// start firing polls; the deployed container sets it to "true".
	// z.coerce.boolean is intentionally NOT used — it treats any non-empty
	// string (including "false") as true — so we match the literal "true".
	POLL_SCHEDULE_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),

	// Port the API listens on. Defaults to 3001 (matches the Vite dev proxy).
	// z.coerce.number turns the string env value into a number; the default
	// applies when PORT is unset (or blank — see emptyAsUndefined).
	PORT: z.preprocess(
		emptyAsUndefined,
		z.coerce.number().int().positive().default(3001),
	),

	// Anthropic API key for Mode A scoring (step 2.2). Optional so the server and
	// one-off scripts boot without it; the AI provider throws a clear error the
	// moment it's actually used without a key, rather than failing at startup.
	// This key never reaches the browser — only the API talks to Anthropic.
	ANTHROPIC_API_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),

	// Which AI backend to use (step 2.1's provider abstraction). "api" = Anthropic
	// Messages API directly; "cli" = shell out to the `claude` CLI (Mode B, no API
	// key); "cowork" = file-queue for a Cowork session (Mode C, no API key).
	// Default "api". (Providers built in lib/ai.ts.)
	AI_PROVIDER: z.preprocess(
		emptyAsUndefined,
		z.enum(["api", "cli", "cowork"]).default("api"),
	),

	// Mode B: the `claude` executable CliProvider runs. Default "claude" (on PATH).
	CLAUDE_BIN: z.preprocess(emptyAsUndefined, z.string().default("claude")),

	// Mode C: root of the file queue CoworkProvider reads/writes (pending/ + done/
	// live under it). Relative paths resolve against the process cwd. Default
	// "ai-queue" at the repo root.
	AI_QUEUE_DIR: z.preprocess(emptyAsUndefined, z.string().default("ai-queue")),

	// Whether the in-process scoring worker drains the scoring_queue on a timer
	// (step 2.4). Off by default so `tsx watch` restarts don't quietly spend money
	// scoring queued postings; the deployed container flips it on. The manual
	// `score:drain` script works regardless of this flag.
	SCORING_WORKER_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
});

// `.parse` throws a readable ZodError listing exactly which vars are missing or
// malformed. This runs at import time, so anything importing `env` is safe.
export const env = EnvSchema.parse(process.env);
