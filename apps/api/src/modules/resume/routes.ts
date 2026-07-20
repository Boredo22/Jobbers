import multipart from "@fastify/multipart";
import {
	ResumeDetailSchema,
	ResumeReviewSchema,
	ResumeVersionSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	createResumeVersion,
	getResumeDetail,
	listResumes,
	reviewResume,
	setActiveResume,
} from "./service";

// ---------------------------------------------------------------------------
// resume/routes.ts — resume upload + versions + AI review (Phase 3, step 3.2).
//
//   • POST /api/resumes            — multipart upload → new active version.
//   • GET  /api/resumes            — version list (metadata).
//   • GET  /api/resumes/:id        — one version + its extracted text.
//   • POST /api/resumes/:id/activate — make this the active resume.
//   • POST /api/resumes/:id/review — AI review against the active profile.
// ---------------------------------------------------------------------------
export async function resumeRoutes(app: FastifyInstance): Promise<void> {
	// Multipart parsing is opt-in per-plugin. 5 MB is plenty for a resume.
	await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

	const r = app.withTypeProvider<ZodTypeProvider>();

	// Upload. Not a JSON body — we read the single file off the multipart stream.
	r.post(
		"/api/resumes",
		{
			schema: {
				response: {
					201: ResumeVersionSchema,
					400: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			const file = await req.file();
			if (!file) return reply.code(400).send({ message: "no file uploaded" });
			try {
				const buffer = await file.toBuffer();
				const created = await createResumeVersion(file.filename, buffer);
				reply.code(201);
				return created;
			} catch (err) {
				// Unsupported type / empty extraction / too large are user errors → 400.
				return reply.code(400).send({
					message: err instanceof Error ? err.message : "upload failed",
				});
			}
		},
	);

	r.get(
		"/api/resumes",
		{ schema: { response: { 200: z.array(ResumeVersionSchema) } } },
		async () => listResumes(),
	);

	r.get(
		"/api/resumes/:id",
		{
			schema: {
				params: z.object({ id: z.string().uuid() }),
				response: {
					200: ResumeDetailSchema,
					404: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			const detail = await getResumeDetail(req.params.id);
			if (!detail) return reply.code(404).send({ message: "resume not found" });
			return detail;
		},
	);

	r.post(
		"/api/resumes/:id/activate",
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
			const ok = await setActiveResume(req.params.id);
			if (!ok) return reply.code(404).send({ message: "resume not found" });
			return { ok: true as const };
		},
	);

	r.post(
		"/api/resumes/:id/review",
		{
			schema: {
				params: z.object({ id: z.string().uuid() }),
				response: {
					200: ResumeReviewSchema,
					404: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			try {
				return await reviewResume(req.params.id);
			} catch (err) {
				if (err instanceof Error && err.message.includes("not found")) {
					return reply.code(404).send({ message: "resume not found" });
				}
				throw err;
			}
		},
	);
}
