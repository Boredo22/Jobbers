import { TailoredDraftRecordSchema, TailoredDraftSchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	latestDraftForPosting,
	NoActiveResumeError,
	saveTailoredDraft,
	tailorPosting,
} from "./service";

// ---------------------------------------------------------------------------
// tailor/routes.ts — tailor-to-posting API (Phase 3, step 3.2b).
//
//   • POST /api/postings/:id/tailor       — AI-draft edits + outreach (not saved).
//   • POST /api/postings/:id/tailor/save  — persist an (edited) draft.
//   • GET  /api/postings/:id/tailor       — the latest saved draft (or null).
//
// Generate returns the raw draft only; the save endpoint re-resolves the active
// resume + application itself, so the client never has to thread provenance back.
// ---------------------------------------------------------------------------
export async function tailorRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();
	const params = z.object({ id: z.string().uuid() });
	const errorBody = z.object({ message: z.string() });

	// Generate a draft. 404 if the posting is unknown; 409 if no active resume.
	r.post(
		"/api/postings/:id/tailor",
		{
			schema: {
				params,
				response: { 200: TailoredDraftSchema, 404: errorBody, 409: errorBody },
			},
		},
		async (req, reply) => {
			try {
				const { draft } = await tailorPosting(req.params.id);
				return draft;
			} catch (err) {
				if (err instanceof NoActiveResumeError) {
					return reply.code(409).send({ message: err.message });
				}
				if (err instanceof Error && err.message.includes("not found")) {
					return reply.code(404).send({ message: "posting not found" });
				}
				throw err;
			}
		},
	);

	// Save an edited draft (body is the human-finished draft content).
	r.post(
		"/api/postings/:id/tailor/save",
		{
			schema: {
				params,
				body: TailoredDraftSchema,
				response: {
					201: TailoredDraftRecordSchema,
					404: errorBody,
					409: errorBody,
				},
			},
		},
		async (req, reply) => {
			try {
				const saved = await saveTailoredDraft(req.params.id, req.body);
				reply.code(201);
				return saved;
			} catch (err) {
				if (err instanceof NoActiveResumeError) {
					return reply.code(409).send({ message: err.message });
				}
				if (err instanceof Error && err.message.includes("not found")) {
					return reply.code(404).send({ message: "posting not found" });
				}
				throw err;
			}
		},
	);

	// The latest saved draft for a posting — null until one is saved.
	r.get(
		"/api/postings/:id/tailor",
		{
			schema: {
				params,
				response: { 200: TailoredDraftRecordSchema.nullable() },
			},
		},
		async (req) => latestDraftForPosting(req.params.id),
	);
}
