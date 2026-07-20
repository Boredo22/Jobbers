import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MODELS } from "../models";
import type { AIProvider, AIRequest, AIResult } from "../provider";
import { toJsonSchema } from "../schema";
import { runStructured, type TextResult } from "./structured";

// ---------------------------------------------------------------------------
// CoworkProvider (Mode C) — get structured output with NO API key and NO CLI, by
// exchanging files with a separate Claude "Cowork" session. complete() drops a
// request file in ai-queue/pending/, a Cowork session (with this folder
// connected) answers it into ai-queue/done/, and we ingest that. It's the third
// proof of the step-2.1 abstraction: same scoring/tailor calls, a totally
// different backend, zero caller changes.
//
// DELIBERATE DEVIATION FROM THE PLAN: docs/IMPLEMENTATION.md sketches an async
// design — complete() returns a "pending" marker immediately and a chokidar
// watcher ingests results later. That doesn't fit the AIProvider contract, which
// promises an AIResult, and would force every caller (scoring, tailor, review) to
// learn a third "pending" outcome. Instead this is a synchronous file-RPC: write
// the request, then poll for the answer with a timeout. Same intent (batch the
// same calls through a Cowork run, compare cost/latency), but it slots into the
// existing worker untouched. The async version is a worthwhile Phase-4 upgrade.
// ---------------------------------------------------------------------------

export interface CoworkProviderOptions {
	/** Root of the file queue. `pending/` and `done/` live under it. */
	queueDir: string;
	/** How long to wait for a `done/` answer before giving up. Default 5 min. */
	timeoutMs?: number;
	/** How often to check for the answer file. Default 2s. */
	pollMs?: number;
	/** Override the tier→model map — used only as a cost-estimate fallback. */
	models?: typeof MODELS;
}

/**
 * The answer file a Cowork session writes to `done/`. `result` is the schema-
 * shaped answer (an object, ideally, but a JSON string is tolerated). Lenient +
 * passthrough — it's external input, so it crosses a Zod boundary (CLAUDE.md §4).
 */
const DoneSchema = z
	.object({
		result: z.unknown(),
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

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export class CoworkProvider implements AIProvider {
	private readonly pendingDir: string;
	private readonly doneDir: string;
	private readonly timeoutMs: number;
	private readonly pollMs: number;
	private readonly models: typeof MODELS;

	constructor(opts: CoworkProviderOptions) {
		this.pendingDir = join(opts.queueDir, "pending");
		this.doneDir = join(opts.queueDir, "done");
		this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
		this.pollMs = opts.pollMs ?? 2_000;
		this.models = opts.models ?? MODELS;
	}

	async complete<T>(req: AIRequest<T>): Promise<AIResult<T>> {
		const invoke = async (prompt: string): Promise<TextResult> => {
			const id = randomUUID();
			await this.writeRequest(id, req, prompt);
			const done = await this.awaitAnswer(id);

			// `result` may be an object (the schema-shaped answer) or a JSON string;
			// stringify objects so runStructured's extractJson re-parses uniformly.
			const text =
				typeof done.result === "string"
					? done.result
					: JSON.stringify(done.result);

			return {
				text,
				inputTokens: done.usage?.input_tokens ?? 0,
				outputTokens: done.usage?.output_tokens ?? 0,
				model: done.model ?? this.models[req.tier],
			};
		};

		return runStructured(req, invoke);
	}

	/** Write one request file atomically (temp + rename) so no half file is read. */
	private async writeRequest(
		id: string,
		req: AIRequest<unknown>,
		prompt: string,
	): Promise<void> {
		await mkdir(this.pendingDir, { recursive: true });
		await mkdir(this.doneDir, { recursive: true });

		const payload = JSON.stringify(
			{
				id,
				schemaName: req.schemaName,
				prompt,
				jsonSchema: toJsonSchema(req.schema),
				meta: { tier: req.tier, maxTokens: req.maxTokens ?? null },
			},
			null,
			2,
		);
		const tmp = join(this.pendingDir, `.${id}.tmp`);
		const final = join(this.pendingDir, `${id}.json`);
		await writeFile(tmp, payload, "utf8");
		await rename(tmp, final);
	}

	/** Poll `done/{id}.json` until it appears; then ingest and clean up both files. */
	private async awaitAnswer(id: string): Promise<z.infer<typeof DoneSchema>> {
		const donePath = join(this.doneDir, `${id}.json`);
		const pendingPath = join(this.pendingDir, `${id}.json`);
		const deadline = Date.now() + this.timeoutMs;

		while (Date.now() < deadline) {
			let raw: string | null = null;
			try {
				raw = await readFile(donePath, "utf8");
			} catch {
				// Not there yet — wait and retry.
				await sleep(this.pollMs);
				continue;
			}

			const parsed = DoneSchema.parse(JSON.parse(raw));
			// Processed — remove both files so the queue reflects only live work.
			await rm(donePath, { force: true });
			await rm(pendingPath, { force: true });
			return parsed;
		}

		// Timed out: drop the stale request so it isn't answered after we've moved on.
		await rm(pendingPath, { force: true });
		throw new Error(
			`CoworkProvider: no answer for request ${id} within ${this.timeoutMs}ms. Is a Cowork session processing ai-queue/pending/?`,
		);
	}
}
