import {
	TailorAssembleRequestSchema,
	TailorAssembleResultSchema,
	TailoredDraftRecordSchema,
	TailoredDraftSchema,
	TailorRequestSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	assembleTailoredResume,
	latestDraftForPosting,
	NoActiveResumeError,
	ResumeNotFoundError,
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
	// Generate echoes back the base it used, so the save can record provenance
	// without re-resolving (which could drift if the active resume changed).
	const generateResponse = z.object({
		draft: TailoredDraftSchema,
		resumeVersionId: z.string().uuid(),
	});
	// Save carries that same id back so the stored row records the exact base.
	const saveBody = TailoredDraftSchema.extend({
		resumeVersionId: z.string().uuid(),
	});

	// Generate a draft. Body selects the base (all fields optional). 404 unknown
	// posting/resume; 409 when nothing resolves to a base at all.
	r.post(
		"/api/postings/:id/tailor",
		{
			schema: {
				params,
				body: TailorRequestSchema,
				response: { 200: generateResponse, 404: errorBody, 409: errorBody },
			},
		},
		async (req, reply) => {
			try {
				const { draft, resumeVersionId } = await tailorPosting(
					req.params.id,
					req.body,
				);
				return { draft, resumeVersionId };
			} catch (err) {
				if (err instanceof NoActiveResumeError) {
					return reply.code(409).send({ message: err.message });
				}
				if (err instanceof ResumeNotFoundError) {
					return reply.code(404).send({ message: err.message });
				}
				if (err instanceof Error && err.message.includes("not found")) {
					return reply.code(404).send({ message: "posting not found" });
				}
				throw err;
			}
		},
	);

	// Save an edited draft (body is the human-finished draft + the base id).
	r.post(
		"/api/postings/:id/tailor/save",
		{
			schema: {
				params,
				body: saveBody,
				response: {
					201: TailoredDraftRecordSchema,
					404: errorBody,
					409: errorBody,
				},
			},
		},
		async (req, reply) => {
			try {
				const { resumeVersionId, ...draft } = req.body;
				const saved = await saveTailoredDraft(
					req.params.id,
					draft,
					resumeVersionId,
				);
				reply.code(201);
				return saved;
			} catch (err) {
				if (err instanceof Error && err.message.includes("not found")) {
					return reply.code(404).send({ message: "posting not found" });
				}
				throw err;
			}
		},
	);

	// Assemble a reviewed draft onto its base → a full tailored resume version.
	// No AI (pure text replacement). 404 unknown posting/base resume.
	r.post(
		"/api/postings/:id/tailor/resume",
		{
			schema: {
				params,
				body: TailorAssembleRequestSchema,
				response: { 201: TailorAssembleResultSchema, 404: errorBody },
			},
		},
		async (req, reply) => {
			try {
				const { draft, resumeVersionId, label } = req.body;
				const result = await assembleTailoredResume(req.params.id, {
					draft,
					resumeVersionId,
					label,
				});
				reply.code(201);
				return result;
			} catch (err) {
				if (err instanceof ResumeNotFoundError) {
					return reply.code(404).send({ message: err.message });
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
