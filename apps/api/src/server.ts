import Fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { adminRoutes } from "./modules/admin/routes";
import { schedulerPlugin } from "./modules/poller/scheduler";

// `.withTypeProvider<ZodTypeProvider>()` rewires Fastify so that any Zod schema
// we attach to a route drives BOTH runtime validation and the handler's types.
// This is the Fastify equivalent of FastAPI reading your Pydantic models.
const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

// Tell Fastify to use Zod for validating requests and serializing responses.
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

// The one route for Phase 0: a liveness probe the React app will poll.
app.get("/api/health", async () => ({
	ok: true,
	ts: new Date().toISOString(),
}));

// Feature modules register their routes as plugins.
app.register(adminRoutes);

// Background jobs are plugins too: this one arms the twice-daily poll cron
// (a no-op unless POLL_SCHEDULE_ENABLED=true).
app.register(schedulerPlugin);

// Top-level await is allowed here because this package is ESM ("type": "module").
try {
	await app.listen({ port: 3001, host: "0.0.0.0" });
} catch (err) {
	app.log.error(err);
	process.exit(1);
}
