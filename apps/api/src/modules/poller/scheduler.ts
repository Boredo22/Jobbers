import type { FastifyInstance } from "fastify";
import cron, { type ScheduledTask } from "node-cron";
import { env } from "../../lib/config";
import { runPoll } from "./run";

// ---------------------------------------------------------------------------
// scheduler.ts — the in-process cron that fires runPoll automatically (step
// 1.5). A Fastify *plugin*: server.ts registers it, and it arms a node-cron
// task on the same process as the API. No separate worker, no external cron
// daemon — "node-cron" is setInterval with a crontab-aware trigger.
//
// Twice a day, 08:00 and 14:00 America/New_York — morning boards and the
// midday refresh, matching how job boards actually update.
// ---------------------------------------------------------------------------

// Standard 5-field crontab: minute hour day-of-month month day-of-week.
// "0 8,14 * * *" = at minute 0 of hours 8 and 14, every day.
const POLL_CRON = "0 8,14 * * *";
const POLL_TZ = "America/New_York";

export async function schedulerPlugin(app: FastifyInstance): Promise<void> {
	// Opt-in so `tsx watch` restarts, tests, and one-off scripts don't quietly
	// start hitting 60+ real ATS boards. The deployed container flips this on.
	if (!env.POLL_SCHEDULE_ENABLED) {
		app.log.info("poll scheduler disabled (POLL_SCHEDULE_ENABLED=false)");
		return;
	}

	const task: ScheduledTask = cron.schedule(
		POLL_CRON,
		async () => {
			// A throw inside a cron tick has no caller to catch it, so contain it
			// here — one bad run must not take down the server or stop the schedule.
			try {
				app.log.info("scheduled poll: starting");
				const summary = await runPoll();
				app.log.info(
					{
						newCount: summary.newCount,
						candidateCount: summary.candidateCount,
						companiesOk: summary.companiesOk,
						companiesFailed: summary.companiesFailed,
					},
					"scheduled poll: finished",
				);
			} catch (err) {
				app.log.error(err, "scheduled poll: failed");
			}
		},
		{
			timezone: POLL_TZ,
			name: "poll",
			// A poll can take a while (dozens of boards); if the next tick arrives
			// before the previous finished, skip it rather than run two at once.
			noOverlap: true,
		},
	);

	app.log.info({ cron: POLL_CRON, tz: POLL_TZ }, "poll scheduler armed");

	// Stop the timer when Fastify shuts down, so nothing fires against a
	// tearing-down process (and tests don't leak a live interval).
	app.addHook("onClose", async () => {
		await task.destroy();
	});
}
