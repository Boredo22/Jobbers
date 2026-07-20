import {
	AiSpendSchema,
	ScoreFeedbackSchema,
	TriageItemSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { enqueueOpenCandidates, processQueueOnce } from "./queue";
import { recordFeedback } from "./service";
import { aiSpendThisMonth, dismissScore, listTriage } from "./triage";

// ---------------------------------------------------------------------------
// scoring/routes.ts — the scoring API (a Fastify plugin, thin like the others).
//
//   • GET  /api/triage — score-sorted postings worth reviewing (step 2.5).
//   • GET  /api/stats/ai-spend — this month's AI cost from the ledger.
//   • POST /api/scores/:id/feedback — your 👍/👎 on a score (feeds Phase 3).
//   • POST /api/scores/:id/dismiss — hide a score from triage.
//   • POST /api/admin/score-candidates — enqueue N open candidates for scoring.
//   • POST /api/admin/score-drain — score one batch now (manual worker tick).
//
// The two admin routes make the step-2.4 checkpoint runnable on demand without
// waiting for a scheduled poll or a long-running worker.
// ---------------------------------------------------------------------------
export async function scoringRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	// GET /api/triage — the review queue: best-first scored postings.
	r.get(
		"/api/triage",
		{ schema: { response: { 200: z.array(TriageItemSchema) } } },
		async () => listTriage(),
	);

	// GET /api/stats/ai-spend — the cost-awareness stat shown on the triage page.
	r.get(
		"/api/stats/ai-spend",
		{ schema: { response: { 200: AiSpendSchema } } },
		async () => aiSpendThisMonth(),
	);

	// POST /api/scores/:id/dismiss — remove a score from triage (not interested).
	r.post(
		"/api/scores/:id/dismiss",
		{
			schema: {
				params: z.object({ id: z.string().uuid() }),
				response: {
					200: z.object({ ok: z.literal(true) }),
					404: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			const ok = await dismissScore(req.params.id);
			if (!ok) return reply.code(404).send({ message: "score not found" });
			return { ok: true as const };
		},
	);

	// Record feedback on a score. 404 if the score id is unknown.
	r.post(
		"/api/scores/:id/feedback",
		{
			schema: {
				params: z.object({ id: z.string().uuid() }),
				body: ScoreFeedbackSchema,
				response: {
					200: z.object({ ok: z.literal(true) }),
					404: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			const ok = await recordFeedback(
				req.params.id,
				req.body.verdict,
				req.body.note,
			);
			if (!ok) return reply.code(404).send({ message: "score not found" });
			return { ok: true as const };
		},
	);

	// Enqueue up to `limit` unscored open candidates. Bounded (default 10, max 200)
	// so a click can't accidentally kick off thousands of paid calls.
	r.post(
		"/api/admin/score-candidates",
		{
			schema: {
				querystring: z.object({
					limit: z.coerce.number().int().min(1).max(200).default(10),
				}),
				response: { 200: z.object({ enqueued: z.number().int() }) },
			},
		},
		async (req) => {
			const enqueued = await enqueueOpenCandidates(req.query.limit);
			return { enqueued };
		},
	);

	// Score one batch right now (a manual worker tick). Returns the drain summary.
	r.post("/api/admin/score-drain", async () => processQueueOnce());
}
