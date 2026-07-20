import { PrefilterSettingsSchema } from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getPrefilterSettings, savePrefilterSettings } from "./service";

// ---------------------------------------------------------------------------
// settings/routes.ts — the editable-config API.
//
//   • GET /api/settings/prefilter — current keyword lists (defaults until the
//     first save).
//   • PUT /api/settings/prefilter — replace both lists. PUT (not PATCH)
//     because the client always sends the complete value it wants stored.
// ---------------------------------------------------------------------------
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();

	r.get(
		"/api/settings/prefilter",
		{ schema: { response: { 200: PrefilterSettingsSchema } } },
		async () => getPrefilterSettings(),
	);

	r.put(
		"/api/settings/prefilter",
		{
			schema: {
				body: PrefilterSettingsSchema,
				response: { 200: PrefilterSettingsSchema },
			},
		},
		async (req) => savePrefilterSettings(req.body),
	);
}
