import { spawn } from "node:child_process";
import { z } from "zod";
import { MODELS } from "../models";
import type { AIProvider, AIRequest, AIResult } from "../provider";
import { runStructured, type TextResult } from "./structured";

// ---------------------------------------------------------------------------
// CliProvider (Mode B) — get structured output by shelling out to the `claude`
// CLI instead of the API. This runs wherever Claude Code is already logged in
// (the homelab), so it needs NO ANTHROPIC_API_KEY — the whole point of the
// step-2.1 abstraction: the scoring/review/tailor callers don't change one line,
// yet the same work now runs through a different backend. Config: AI_PROVIDER=cli.
//
// The CLI can't force tool use, so we can't guarantee structure the way Mode A
// does. Instead we lean on the shared runStructured helper: instruct the model
// with the JSON Schema in the prompt, then parse + validate + retry the text. The
// only CLI-specific work here is "run `claude -p --output-format json` and pull
// the assistant text out of its JSON envelope".
// ---------------------------------------------------------------------------

export interface CliProviderOptions {
	/** The `claude` executable to run. Default "claude" (found on PATH). */
	claudeBin?: string;
	/** Working directory for the child process (defaults to the parent's cwd). */
	cwd?: string;
	/** Override the tier→model map — used only as a cost-estimate fallback. */
	models?: typeof MODELS;
}

/**
 * The relevant slice of `claude -p --output-format json`'s stdout. Lenient +
 * passthrough: the CLI adds fields across versions and we validate only the few
 * we read (CLAUDE.md §4 — even the CLI's stdout crosses a Zod boundary).
 */
const CliEnvelopeSchema = z
	.object({
		is_error: z.boolean().optional(),
		subtype: z.string().optional(),
		result: z.string().optional(),
		duration_ms: z.number().optional(),
		model: z.string().optional(),
		usage: z
			.object({
				input_tokens: z.number().optional(),
				output_tokens: z.number().optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

/** Run the CLI once with `prompt` on stdin; resolve its raw stdout string. */
function runClaude(
	claudeBin: string,
	cwd: string | undefined,
	prompt: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		// Prompt goes on STDIN, not argv — avoids the OS arg-length limit for long
		// JDs/resumes, and keeps the prompt out of the process table.
		const child = spawn(claudeBin, ["-p", "--output-format", "json"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (err) => {
			// ENOENT here means the `claude` binary isn't on PATH — say so clearly.
			reject(
				new Error(
					`CliProvider: failed to run "${claudeBin}" (${err.message}). Is Claude Code installed and logged in?`,
				),
			);
		});
		child.on("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`CliProvider: "${claudeBin}" exited ${code}: ${stderr.trim()}`,
					),
				);
				return;
			}
			resolve(stdout);
		});

		child.stdin.write(prompt);
		child.stdin.end();
	});
}

export class CliProvider implements AIProvider {
	private readonly claudeBin: string;
	private readonly cwd: string | undefined;
	private readonly models: typeof MODELS;

	constructor(opts: CliProviderOptions = {}) {
		this.claudeBin = opts.claudeBin ?? "claude";
		this.cwd = opts.cwd;
		this.models = opts.models ?? MODELS;
	}

	async complete<T>(req: AIRequest<T>): Promise<AIResult<T>> {
		const invoke = async (prompt: string): Promise<TextResult> => {
			const raw = await runClaude(this.claudeBin, this.cwd, prompt);

			let env: z.infer<typeof CliEnvelopeSchema>;
			try {
				env = CliEnvelopeSchema.parse(JSON.parse(raw));
			} catch (err) {
				throw new Error(
					`CliProvider: could not parse CLI JSON envelope: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
			if (env.is_error) {
				throw new Error(`CliProvider: CLI reported an error (${env.subtype}).`);
			}

			return {
				text: env.result ?? "",
				inputTokens: env.usage?.input_tokens ?? 0,
				outputTokens: env.usage?.output_tokens ?? 0,
				// Prefer the model the CLI actually used; fall back to the tier's model
				// id so the ai_runs cost estimate still resolves (the CLI's real spend
				// is a subscription — we log the API-equivalent cost for comparison).
				model: env.model ?? this.models[req.tier],
			};
		};

		return runStructured(req, invoke);
	}
}
