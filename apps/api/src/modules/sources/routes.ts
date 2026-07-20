import { SourceSummarySchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listSources } from "./service";

// ---------------------------------------------------------------------------
// sources/routes.ts — the ingestion registry API (Settings page).
//
//   • GET /api/sources — every data source, its status, and (for active ones)
//     its endpoint count, poll health, and last-run info.
// ---------------------------------------------------------------------------
export async function sourcesRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	r.get(
		"/api/sources",
		{ schema: { response: { 200: z.array(SourceSummarySchema) } } },
		async () => listSources(),
	);
}
