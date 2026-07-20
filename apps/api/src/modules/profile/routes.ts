import {
	IdealJobProfileSchema,
	ProfileProposeSchema,
	ProfileVersionSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { rescoreOpenScored } from "../scoring/queue";
import { getActiveProfile, proposeProfile, saveProfile } from "./service";

// ---------------------------------------------------------------------------
// profile/routes.ts — the Ideal Job Profile API (Phase 3, step 3.1).
//
//   • GET  /api/profile          — the active profile (or null).
//   • POST /api/profile/propose  — AI-draft a profile from notes+resume+history.
//   • POST /api/profile          — save an (edited) profile as a new version.
//   • POST /api/profile/rescore  — re-queue open scored postings for re-scoring.
// ---------------------------------------------------------------------------
export async function profileRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	// GET /api/profile — null until the first save.
	r.get(
		"/api/profile",
		{ schema: { response: { 200: ProfileVersionSchema.nullable() } } },
		async () => getActiveProfile(),
	);

	// POST /api/profile/propose — a draft the user edits; NOT saved here.
	r.post(
		"/api/profile/propose",
		{
			schema: {
				body: ProfileProposeSchema,
				response: { 200: IdealJobProfileSchema },
			},
		},
		async (req) => proposeProfile(req.body.notes),
	);

	// POST /api/profile — persist as a new active version.
	r.post(
		"/api/profile",
		{
			schema: {
				body: IdealJobProfileSchema,
				response: { 201: ProfileVersionSchema },
			},
		},
		async (req, reply) => {
			const saved = await saveProfile(req.body);
			reply.code(201);
			return saved;
		},
	);

	// POST /api/profile/rescore — queue open scored postings to be re-scored
	// against the current active profile (drain to apply). Returns the count.
	r.post(
		"/api/profile/rescore",
		{ schema: { response: { 200: z.object({ enqueued: z.number().int() }) } } },
		async () => ({ enqueued: await rescoreOpenScored() }),
	);
}
