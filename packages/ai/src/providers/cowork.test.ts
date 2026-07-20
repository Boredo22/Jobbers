import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CoworkProvider } from "./cowork";

// ---------------------------------------------------------------------------
// cowork.test.ts — drives CoworkProvider's file-RPC end to end against a real
// temp directory (no DB, no API key, no CLI). Proves the contract that matters:
// a request lands in pending/, an answer in done/ is validated and returned, and
// both files are cleaned up. This is the offline stand-in for the human/Cowork
// session — the manual checkpoint does the same thing by hand.
// ---------------------------------------------------------------------------

const Schema = z.object({ score: z.number().min(0).max(10), note: z.string() });

/** Poll pending/ for the request file the provider just wrote; return its id. */
async function waitForRequest(pendingDir: string): Promise<string> {
	for (let i = 0; i < 100; i++) {
		const files = (await readdir(pendingDir).catch(() => [])).filter((f) =>
			f.endsWith(".json"),
		);
		if (files[0]) return files[0].replace(".json", "");
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("no request file appeared in pending/");
}

describe("CoworkProvider", () => {
	it("round-trips a request → answer and cleans up both files", async () => {
		const queueDir = await mkdtemp(join(tmpdir(), "jobber-cowork-"));
		const provider = new CoworkProvider({
			queueDir,
			pollMs: 20,
			timeoutMs: 5000,
		});

		// Start the call; it writes the request and begins polling for the answer.
		const pending = provider.complete({
			prompt: "Score this fake job.",
			schema: Schema,
			schemaName: "smoke",
			tier: "small",
		});

		// Act as the Cowork session: answer the request (with prose, to prove the
		// tolerant extraction path).
		const id = await waitForRequest(join(queueDir, "pending"));
		await writeFile(
			join(queueDir, "done", `${id}.json`),
			JSON.stringify({
				id,
				result: { score: 8.5, note: "strong fit" },
				model: "claude-sonnet-5",
				usage: { input_tokens: 1200, output_tokens: 80 },
			}),
		);

		const res = await pending;
		expect(res.data).toEqual({ score: 8.5, note: "strong fit" });
		expect(res.inputTokens).toBe(1200);
		expect(res.model).toBe("claude-sonnet-5");

		// Ingest removes both files, so the queue reflects only live work.
		expect(await readdir(join(queueDir, "pending"))).toHaveLength(0);
		expect(await readdir(join(queueDir, "done"))).toHaveLength(0);
	});

	it("times out with a clear error when nobody answers", async () => {
		const queueDir = await mkdtemp(join(tmpdir(), "jobber-cowork-"));
		const provider = new CoworkProvider({
			queueDir,
			pollMs: 20,
			timeoutMs: 120,
		});
		await expect(
			provider.complete({
				prompt: "unanswered",
				schema: Schema,
				schemaName: "smoke",
				tier: "small",
			}),
		).rejects.toThrow(/no answer/);
	});
});
