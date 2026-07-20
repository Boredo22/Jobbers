import {
	CoverLetterRequestSchema,
	CoverLetterResponseSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { draftCoverLetter } from "./service";

// ---------------------------------------------------------------------------
// cover-letter/routes.ts — the Chrome extension's one endpoint.
//
//   • POST /api/cover-letter — scanned job-page text in, letter draft out.
//
// The caller is the extension's background service worker (not the web app),
// but the contract works the same way: both sides validate against the shared
// schemas. Nothing is stored — the ai_runs ledger row is the only trace.
// ---------------------------------------------------------------------------
export async function coverLetterRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();
	const errorBody = z.object({ message: z.string() });

	r.post(
		"/api/cover-letter",
		{
			schema: {
				body: CoverLetterRequestSchema,
				response: { 200: CoverLetterResponseSchema, 502: errorBody },
			},
		},
		async (req, reply) => {
			try {
				return await draftCoverLetter(req.body);
			} catch (err) {
				// Provider failures (missing key, model refusal, timeout) come back
				// as a readable message the sidebar can show, not a bare 500.
				req.log.error(err, "cover-letter draft failed");
				const message =
					err instanceof Error ? err.message : "cover letter draft failed";
				return reply.code(502).send({ message });
			}
		},
	);
}
