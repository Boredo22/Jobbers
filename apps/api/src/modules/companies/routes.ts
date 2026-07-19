import { CompanyListItemSchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listCompanies } from "./service";

// ---------------------------------------------------------------------------
// companies/routes.ts — read-only listing for the /companies page (step 1.7).
// ---------------------------------------------------------------------------
export async function companiesRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	r.get(
		"/api/companies",
		{ schema: { response: { 200: z.array(CompanyListItemSchema) } } },
		async () => listCompanies(),
	);
}
