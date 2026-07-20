import { ScoreFeedbackSchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { enqueueOpenCandidates, processQueueOnce } from "./queue";
import { recordFeedback } from "./service";

// ---------------------------------------------------------------------------
// scoring/routes.ts — the scoring API (a Fastify plugin, thin like the others).
//
//   • POST /api/scores/:id/feedback — your 👍/👎 on a score (feeds Phase 3).
//   • POST /api/admin/score-candidates — enqueue N open candidates for scoring.
//   • POST /api/admin/score-drain — score one batch now (manual worker tick).
//
// The two admin routes make the step-2.4 checkpoint runnable on demand without
// waiting for a scheduled poll or a long-running worker.
// ---------------------------------------------------------------------------
export async function scoringRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

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
