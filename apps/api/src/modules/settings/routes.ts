import { OPENROUTER_DEFAULT_MODELS } from "@jobber/ai";
import {
	AiModelSettingsResponseSchema,
	AiModelSettingsSchema,
	PrefilterSettingsSchema,
} from "@jobber/shared";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../../lib/config";
import { findUnknownSlug, getCatalog } from "../models/service";
import {
	getAiModelSettings,
	getPrefilterSettings,
	putAiModelSettings,
	savePrefilterSettings,
} from "./service";

// ---------------------------------------------------------------------------
// settings/routes.ts — the editable-config API.
//
//   • GET/PUT /api/settings/prefilter — the title-keyword lists.
//   • GET/PUT /api/settings/ai-models — which OpenRouter model serves each
//     tier. The PUT validates both slugs against the live catalog before
//     storing, so a typo'd or tools-incapable model is a 400 here, never a
//     runtime failure mid-scoring.
// PUT (not PATCH) throughout: the client always sends the complete value.
// ---------------------------------------------------------------------------
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
	const r = app.withTypeProvider<ZodTypeProvider>();
	const errorBody = z.object({ message: z.string() });

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

	r.get(
		"/api/settings/ai-models",
		{ schema: { response: { 200: AiModelSettingsResponseSchema } } },
		async () => ({
			settings: await getAiModelSettings(),
			defaults: OPENROUTER_DEFAULT_MODELS,
			activeProvider: env.AI_PROVIDER,
		}),
	);

	r.put(
		"/api/settings/ai-models",
		{
			schema: {
				body: AiModelSettingsSchema,
				response: {
					200: AiModelSettingsSchema,
					400: errorBody,
					502: errorBody,
				},
			},
		},
		async (req, reply) => {
			let models: Awaited<ReturnType<typeof getCatalog>>["models"];
			try {
				models = (await getCatalog()).models;
			} catch (err) {
				req.log.error(err, "catalog unavailable for slug validation");
				return reply
					.code(502)
					.send({ message: "OpenRouter catalog unavailable — try again." });
			}
			const bad = findUnknownSlug(req.body, models);
			if (bad) {
				return reply.code(400).send({
					message: `"${bad}" is not a tools-capable model in the OpenRouter catalog.`,
				});
			}
			return putAiModelSettings(req.body);
		},
	);
}
