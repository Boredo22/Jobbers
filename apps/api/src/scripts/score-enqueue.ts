import { queryClient } from "../db/client";
import { enqueueOpenCandidates, pendingCount } from "../modules/scoring/queue";

// ---------------------------------------------------------------------------
// score-enqueue.ts — queue up to N open candidate postings for scoring.
//
// Run:  pnpm --filter api score:enqueue        (default 10)
//       pnpm --filter api score:enqueue 25     (a specific count)
//
// Bounded on purpose — each queued posting becomes a paid model call when
// drained, so you decide how many. Idempotent: already-queued/scored postings
// are skipped.
// ---------------------------------------------------------------------------

const limit = Number(process.argv[2] ?? 10);

try {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error(`bad limit "${process.argv[2]}" — pass a positive integer`);
	}
	const enqueued = await enqueueOpenCandidates(limit);
	const pending = await pendingCount();
	console.log(
		`Enqueued ${enqueued} candidate(s). ${pending} posting(s) now pending. Run "pnpm --filter api score:drain" to score them.`,
	);
} catch (err) {
	console.error("score-enqueue failed:", err);
	process.exitCode = 1;
} finally {
	await queryClient.end();
}
