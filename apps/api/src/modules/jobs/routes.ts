import { JobListItemSchema, JobsQuerySchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listJobs } from "./service";

// ---------------------------------------------------------------------------
// jobs/routes.ts — read-only listing of postings for the /jobs UI (step 1.7).
// ---------------------------------------------------------------------------
export async function jobsRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	// GET /api/jobs?status=open&candidate=true&companyId=... — every param
	// optional. Zod parses the querystring (including the "true"/"false"→boolean
	// conversion) before the handler runs; a bad value is a 400, never a surprise.
	r.get(
		"/api/jobs",
		{
			schema: {
				querystring: JobsQuerySchema,
				response: { 200: z.array(JobListItemSchema) },
			},
		},
		async (req) => listJobs(req.query),
	);
}
