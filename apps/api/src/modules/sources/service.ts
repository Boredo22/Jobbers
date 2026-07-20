import type { SourceSummary } from "@jobber/shared";
import { desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { companies, jobPostings, pollRuns } from "../../db/schema";

// ---------------------------------------------------------------------------
// sources/service.ts — the ingestion registry behind the Settings page.
//
// It answers one question: "what is being pinged or scraped, and how is it
// doing?" Today only the ATS poller is active; the Phase-4 sources (HN, RSS,
// bookmarklet, IMAP) are listed as `planned` so the page shows the whole roadmap
// of inputs, not just what's wired up. As each Phase-4 source lands, flip its
// status to `active` and fill in its real counts here — the page needs no change.
// ---------------------------------------------------------------------------

/** Postings in the DB grouped by their `source` column: total + currently open. */
async function jobCountsBySource(): Promise<
	Map<string, { total: number; open: number }>
> {
	const rows = await db
		.select({
			source: jobPostings.source,
			total: sql<number>`count(*)::int`,
			open: sql<number>`(count(*) filter (where ${jobPostings.status} = 'open'))::int`,
		})
		.from(jobPostings)
		.groupBy(jobPostings.source);
	return new Map(rows.map((r) => [r.source, { total: r.total, open: r.open }]));
}

/** ATS-poller board stats: how many active boards per platform, and health. */
async function pollerStats(): Promise<{
	endpoints: number;
	byPlatform: Record<string, number>;
	health: { ok: number; failing: number };
	lastRunAt: Date | null;
	lastRunNew: number | null;
}> {
	const companyRows = await db.select().from(companies);
	const boards = companyRows.filter(
		(c) => c.active && c.atsType !== "manual" && c.atsToken,
	);
	const byPlatform: Record<string, number> = {};
	for (const c of boards) {
		byPlatform[c.atsType] = (byPlatform[c.atsType] ?? 0) + 1;
	}

	const [latestRun] = await db
		.select({
			startedAt: pollRuns.startedAt,
			newCount: pollRuns.newCount,
			failures: pollRuns.failures,
		})
		.from(pollRuns)
		.orderBy(desc(pollRuns.startedAt))
		.limit(1);

	const failing = latestRun?.failures.length ?? 0;
	return {
		endpoints: boards.length,
		byPlatform,
		// Before the first poll we can't know per-board health, so report all as ok=0.
		health: latestRun
			? { ok: boards.length - failing, failing }
			: { ok: 0, failing: 0 },
		lastRunAt: latestRun?.startedAt ?? null,
		lastRunNew: latestRun?.newCount ?? null,
	};
}

/** The full source registry — active poller plus the planned Phase-4 inputs. */
export async function listSources(): Promise<SourceSummary[]> {
	const [counts, poller] = await Promise.all([
		jobCountsBySource(),
		pollerStats(),
	]);
	const count = (key: string) => counts.get(key) ?? { total: 0, open: 0 };

	const platformSummary =
		Object.entries(poller.byPlatform)
			.map(([p, n]) => `${p} ${n}`)
			.join(" · ") || "no boards configured";

	const poll = count("poller");
	const manual = count("manual");
	const hn = count("hn");
	const rss = count("rss");

	return [
		{
			key: "poller",
			label: "ATS Poller",
			kind: "ats",
			status: "active",
			description: `Polls applicant-tracking boards for open roles (${platformSummary}).`,
			jobCount: poll.total,
			openJobCount: poll.open,
			endpoints: poller.endpoints,
			health: poller.health,
			lastRunAt: poller.lastRunAt,
			lastRunNew: poller.lastRunNew,
			schedule: "Twice daily · 08:00 & 14:00 America/New_York",
		},
		{
			key: "hn",
			label: "HN — Who is Hiring",
			kind: "aggregator",
			status: "planned",
			description:
				"Monthly Hacker News thread, parsed into postings via the Algolia HN API (Phase 4).",
			jobCount: hn.total,
			openJobCount: hn.open,
			endpoints: null,
			health: null,
			lastRunAt: null,
			lastRunNew: null,
			schedule: "Monthly · 1st @ 10:00 ET (planned)",
		},
		{
			key: "rss",
			label: "RSS feeds",
			kind: "aggregator",
			status: "planned",
			description:
				"Remote job feeds (WeWorkRemotely, Remotive) into the same normalize→upsert path (Phase 4).",
			jobCount: rss.total,
			openJobCount: rss.open,
			endpoints: null,
			health: null,
			lastRunAt: null,
			lastRunNew: null,
			schedule: null,
		},
		{
			key: "manual",
			label: "Bookmarklet capture",
			kind: "manual",
			status: "planned",
			description:
				"Capture any job page you're viewing via a bookmarklet → LLM-parsed into a posting (Phase 4).",
			jobCount: manual.total,
			openJobCount: manual.open,
			endpoints: null,
			health: null,
			lastRunAt: null,
			lastRunNew: null,
			schedule: "On demand",
		},
		{
			key: "imap",
			label: "Email (IMAP) status ingestion",
			kind: "email",
			status: "planned",
			description:
				"Reads your inbox for application acks/rejections/interviews → proposed pipeline events you confirm (Phase 4). A signal source — it never creates postings.",
			jobCount: null,
			openJobCount: null,
			endpoints: null,
			health: null,
			lastRunAt: null,
			lastRunNew: null,
			schedule: "Polled (planned)",
		},
	];
}
