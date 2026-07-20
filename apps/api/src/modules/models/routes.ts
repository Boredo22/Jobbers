import { ModelsCatalogSchema, ModelsUsageSchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getCatalog, getModelUsage } from "./service";

// ---------------------------------------------------------------------------
// models/routes.ts — the OpenRouter catalog, proxied, plus the usage ledger.
//
//   • GET /api/models — tools-capable models with per-MTok pricing.
//   • GET /api/models/usage — ai_runs grouped by model (calls/tokens/spend).
//
// The browser never talks to OpenRouter directly: the api owns the fetch, the
// Zod boundary, and the 1-hour cache. 502 only when OpenRouter is down AND
// nothing is cached yet.
// ---------------------------------------------------------------------------
export async function modelsRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();
	const errorBody = z.object({ message: z.string() });

	r.get(
		"/api/models",
		{ schema: { response: { 200: ModelsCatalogSchema, 502: errorBody } } },
		async (req, reply) => {
			try {
				return await getCatalog();
			} catch (err) {
				req.log.error(err, "openrouter catalog fetch failed");
				const message =
					err instanceof Error ? err.message : "catalog fetch failed";
				return reply.code(502).send({ message });
			}
		},
	);

	r.get(
		"/api/models/usage",
		{ schema: { response: { 200: ModelsUsageSchema } } },
		async () => ({ usage: await getModelUsage() }),
	);
}
