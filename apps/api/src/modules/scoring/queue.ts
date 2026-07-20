import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../../db/client";
import { fitScores, jobPostings, scoringQueue } from "../../db/schema";
import { env } from "../../lib/config";
import { isCandidate } from "../poller/prefilter";
import { notifyHighScore, scorePosting } from "./service";

// ---------------------------------------------------------------------------
// scoring/queue.ts — the "queue" and its worker.
//
// v1 queue = a DB table (scoring_queue) drained by a setInterval loop in the API
// process. That's deliberate over Redis/BullMQ: it's visible (you can `select *`
// it in psql), restart-safe (pending rows persist and get picked up on boot),
// and has zero extra infrastructure. The poller enqueues new candidates; the
// worker scores them a few at a time and notifies you about the good ones.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3; // give up on a posting after this many failures
const HIGH_SCORE = 8; // ntfy fires at or above this
const BATCH = 5; // postings scored per worker tick (polite, cheap)
const TICK_MS = 20_000; // how often the worker wakes up

/**
 * Enqueue postings for scoring. UNIQUE(job_posting_id) + onConflictDoNothing
 * makes this idempotent: a posting already in the queue (pending, done, or error)
 * is not re-added. Returns how many were newly enqueued.
 */
export async function enqueueForScoring(
	jobPostingIds: string[],
): Promise<number> {
	if (jobPostingIds.length === 0) return 0;
	const inserted = await db
		.insert(scoringQueue)
		.values(jobPostingIds.map((jobPostingId) => ({ jobPostingId })))
		.onConflictDoNothing({ target: scoringQueue.jobPostingId })
		.returning({ id: scoringQueue.id });
	return inserted.length;
}

/**
 * Enqueue up to `limit` open postings that (a) pass the prefilter, (b) aren't
 * already scored, and (c) aren't already queued. This is the manual path for the
 * step-2.4 checkpoint — score existing candidates without waiting for a poll to
 * surface new ones. Bounded by `limit` so you control the spend.
 */
export async function enqueueOpenCandidates(limit: number): Promise<number> {
	// Open postings with no fit_scores row and no scoring_queue row yet. The
	// prefilter (title/location/remote) isn't expressible in SQL, so we fetch the
	// small candidate-ish columns and apply it in memory, then take `limit`.
	const rows = await db
		.select({
			id: jobPostings.id,
			title: jobPostings.title,
			location: jobPostings.location,
			remote: jobPostings.remote,
		})
		.from(jobPostings)
		.leftJoin(scoringQueue, eq(scoringQueue.jobPostingId, jobPostings.id))
		.leftJoin(fitScores, eq(fitScores.jobPostingId, jobPostings.id))
		.where(
			and(
				eq(jobPostings.status, "open"),
				isNull(scoringQueue.id),
				isNull(fitScores.id),
			),
		);

	const ids = rows
		.filter((r) => isCandidate(r))
		.slice(0, limit)
		.map((r) => r.id);
	return enqueueForScoring(ids);
}

export type DrainSummary = {
	processed: number;
	scored: number;
	failed: number;
	notified: number;
};

/**
 * Score up to `batch` pending postings, one at a time (polite + simple). Each
 * success marks the row done and, for a high score, fires a push. Each failure
 * bumps the attempt count and, past MAX_ATTEMPTS, parks the row as "error" (kept
 * for audit, never retried). Returns a summary. Never throws — a bad posting
 * can't stall the whole drain.
 */
export async function processQueueOnce(batch = BATCH): Promise<DrainSummary> {
	const pending = await db
		.select({
			id: scoringQueue.id,
			jobPostingId: scoringQueue.jobPostingId,
			attempts: scoringQueue.attempts,
		})
		.from(scoringQueue)
		.where(eq(scoringQueue.status, "pending"))
		.orderBy(asc(scoringQueue.enqueuedAt))
		.limit(batch);

	const summary: DrainSummary = {
		processed: 0,
		scored: 0,
		failed: 0,
		notified: 0,
	};

	for (const item of pending) {
		summary.processed++;
		try {
			const result = await scorePosting(item.jobPostingId);
			await db
				.update(scoringQueue)
				.set({ status: "done", updatedAt: new Date() })
				.where(eq(scoringQueue.id, item.id));
			summary.scored++;
			if (result.score >= HIGH_SCORE) {
				await notifyHighScore(result);
				summary.notified++;
			}
		} catch (err) {
			const attempts = item.attempts + 1;
			await db
				.update(scoringQueue)
				.set({
					attempts,
					status: attempts >= MAX_ATTEMPTS ? "error" : "pending",
					lastError: err instanceof Error ? err.message : String(err),
					updatedAt: new Date(),
				})
				.where(eq(scoringQueue.id, item.id));
			summary.failed++;
		}
	}

	return summary;
}

/** How many postings are still pending — handy for scripts/logging. */
export async function pendingCount(): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(scoringQueue)
		.where(eq(scoringQueue.status, "pending"));
	return row?.n ?? 0;
}

/**
 * The background worker, as a Fastify plugin. Off unless SCORING_WORKER_ENABLED,
 * and a no-op (with a warning) if there's no API key to score with. An overlap
 * guard makes sure a slow tick never runs concurrently with the next one.
 */
export async function scoringWorkerPlugin(app: FastifyInstance): Promise<void> {
	if (!env.SCORING_WORKER_ENABLED) {
		app.log.info("scoring worker disabled (SCORING_WORKER_ENABLED=false)");
		return;
	}
	if (env.AI_PROVIDER === "api" && !env.ANTHROPIC_API_KEY) {
		app.log.warn(
			"scoring worker enabled but ANTHROPIC_API_KEY unset; not starting",
		);
		return;
	}

	let running = false;
	const timer = setInterval(async () => {
		if (running) return; // previous tick still going — skip this one
		running = true;
		try {
			const s = await processQueueOnce();
			if (s.processed > 0) app.log.info(s, "scoring worker: tick");
		} catch (err) {
			app.log.error(err, "scoring worker: tick failed");
		} finally {
			running = false;
		}
	}, TICK_MS);

	app.log.info({ tickMs: TICK_MS }, "scoring worker armed");
	app.addHook("onClose", async () => clearInterval(timer));
}
