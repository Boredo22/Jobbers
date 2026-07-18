import type { FastifyInstance } from "fastify";
import { runPoll } from "../poller/run";

// ---------------------------------------------------------------------------
// admin/routes.ts — operational endpoints. A Fastify *plugin*: a function that
// receives the app and registers routes on it. server.ts composes the API by
// registering plugins like this one (Fastify's unit of modularity).
// ---------------------------------------------------------------------------
export async function adminRoutes(app: FastifyInstance): Promise<void> {
	// Manually trigger a poll of every board. Long-running (fetches ~68 boards),
	// which is fine for a deliberate admin action; automated scheduling arrives
	// in step 1.5. Returns the run summary as JSON.
	app.post("/api/admin/poll", async () => {
		return runPoll();
	});
}
