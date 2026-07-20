import { queryClient } from "../db/client";
import { pendingCount, processQueueOnce } from "../modules/scoring/queue";

// ---------------------------------------------------------------------------
// score-drain.ts — run the scoring worker's logic to completion, then exit.
//
// Run:  pnpm --filter api score:drain   (needs ANTHROPIC_API_KEY in .env)
//
// This is the same processQueueOnce() the background worker calls, looped until
// the queue is empty — a self-contained way to score everything you enqueued
// without leaving a server running. A safety cap stops a runaway loop.
// ---------------------------------------------------------------------------

const MAX_BATCHES = 100; // safety net: at BATCH=5 that's up to 500 postings

async function main() {
	const totals = { processed: 0, scored: 0, failed: 0, notified: 0 };

	for (let i = 0; i < MAX_BATCHES; i++) {
		const s = await processQueueOnce();
		if (s.processed === 0) break; // queue drained
		totals.processed += s.processed;
		totals.scored += s.scored;
		totals.failed += s.failed;
		totals.notified += s.notified;
		console.log(
			`batch: processed=${s.processed} scored=${s.scored} failed=${s.failed} notified=${s.notified}`,
		);
	}

	const stillPending = await pendingCount();
	console.log(
		`\nDone. scored=${totals.scored} failed=${totals.failed} notified(≥8)=${totals.notified}. ${stillPending} still pending.`,
	);
}

try {
	await main();
} catch (err) {
	console.error("score-drain failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
