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

const EnvSchema = z.object({
	// The postgres.js connection string, e.g.
	// postgres://jobber:<password>@localhost:5432/jobber
	DATABASE_URL: z.string().url(),
});

// `.parse` throws a readable ZodError listing exactly which vars are missing or
// malformed. This runs at import time, so anything importing `env` is safe.
export const env = EnvSchema.parse(process.env);
