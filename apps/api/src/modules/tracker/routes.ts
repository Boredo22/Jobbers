import {
	ApplicationCreateSchema,
	ApplicationStatusUpdateSchema,
	ApplicationWithEventsSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
	createApplication,
	listApplications,
	updateApplicationStatus,
} from "./service";

// ---------------------------------------------------------------------------
// tracker/routes.ts — the pipeline API. A Fastify plugin (see step 1.4/1.5).
//
// Routes stay THIN: they declare their Zod schemas (which drive both runtime
// validation and handler types — the "Pydantic moment") and delegate all DB
// work to service.ts. The schemas come from @jobber/shared so the web app
// validates responses against the exact same shapes.
// ---------------------------------------------------------------------------
export async function trackerRoutes(app: FastifyInstance): Promise<void> {
	// `.withTypeProvider` re-types this instance so `schema: { ... }` entries are
	// understood as Zod. server.ts already set the validator/serializer compilers.
	const r = app.withTypeProvider<ZodTypeProvider>();

	// GET /api/applications — the whole pipeline, newest first, each with its
	// event timeline. The response schema makes Fastify serialize (and guarantee)
	// the shape the UI will parse.
	r.get(
		"/api/applications",
		{ schema: { response: { 200: z.array(ApplicationWithEventsSchema) } } },
		async () => listApplications(),
	);

	// POST /api/applications — record a new application. Body is validated by the
	// shared create schema; a 400 is returned automatically on a bad body.
	r.post(
		"/api/applications",
		{
			schema: {
				body: ApplicationCreateSchema,
				response: { 201: ApplicationWithEventsSchema },
			},
		},
		async (req, reply) => {
			const created = await createApplication(req.body);
			reply.code(201);
			return created;
		},
	);

	// PATCH /api/applications/:id/status — the status change. Writes an event row
	// AND updates the denormalized column (in service.ts, transactionally).
	r.patch(
		"/api/applications/:id/status",
		{
			schema: {
				params: z.object({ id: z.string().uuid() }),
				body: ApplicationStatusUpdateSchema,
				response: {
					200: ApplicationWithEventsSchema,
					404: z.object({ message: z.string() }),
				},
			},
		},
		async (req, reply) => {
			const updated = await updateApplicationStatus(
				req.params.id,
				req.body.status,
				req.body.detail,
			);
			if (!updated) return reply.code(404).send({ message: "not found" });
			return updated;
		},
	);
}
