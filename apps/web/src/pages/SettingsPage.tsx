import {
	type SourceStatus,
	type SourceSummary,
	SourceSummarySchema,
} from "@jobber/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { apiGet } from "@/lib/api";

// ---------------------------------------------------------------------------
// SettingsPage — the ingestion registry: every source that feeds the app, its
// status, and (for the live ones) how many endpoints it pings, poll health, and
// the last run. Reads GET /api/sources; the Phase-4 sources show as "planned".
// ---------------------------------------------------------------------------

const SourceListSchema = z.array(SourceSummarySchema);

const STATUS_BADGE: Record<
	SourceStatus,
	{ label: string; variant: BadgeProps["variant"] }
> = {
	active: { label: "active", variant: "green" },
	planned: { label: "planned", variant: "neutral" },
	disabled: { label: "disabled", variant: "red" },
};

function fmtDateTime(d: Date | null): string {
	return d ? new Date(d).toLocaleString() : "never";
}

function SourceCard({ s }: { s: SourceSummary }) {
	const status = STATUS_BADGE[s.status];
	return (
		<Card className={s.status === "planned" ? "opacity-70" : undefined}>
			<CardContent className="space-y-3 p-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{s.label}</span>
					<Badge variant={status.variant}>{status.label}</Badge>
					<Badge variant="outline">{s.kind}</Badge>
					{s.status === "active" && s.health && (
						<Badge variant={s.health.failing > 0 ? "amber" : "green"}>
							{s.health.ok} ok
							{s.health.failing > 0 ? ` · ${s.health.failing} failing` : ""}
						</Badge>
					)}
				</div>

				<p className="text-slate-600 text-sm">{s.description}</p>

				{/* Facts grid — only the cells that apply to this source render. */}
				<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
					{s.endpoints !== null && (
						<Stat label="Endpoints" value={s.endpoints.toLocaleString()} />
					)}
					{s.jobCount !== null && (
						<Stat
							label="Postings"
							value={`${s.openJobCount ?? 0} open / ${s.jobCount}`}
						/>
					)}
					{s.status === "active" && (
						<Stat label="Last run" value={fmtDateTime(s.lastRunAt)} />
					)}
					{s.lastRunNew !== null && (
						<Stat label="New last run" value={s.lastRunNew.toLocaleString()} />
					)}
					{s.schedule && <Stat label="Schedule" value={s.schedule} />}
				</dl>
			</CardContent>
		</Card>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt className="text-slate-400 text-xs">{label}</dt>
			<dd className="text-slate-700 tabular-nums">{value}</dd>
		</div>
	);
}

export function SettingsPage() {
	const { data, isPending, isError } = useQuery({
		queryKey: ["sources"],
		queryFn: () => apiGet("/api/sources", SourceListSchema),
	});

	return (
		<div className="max-w-3xl space-y-5">
			<div>
				<h2 className="font-semibold text-2xl">Settings</h2>
				<p className="text-slate-500 text-sm">
					Every source that feeds jobs (or signals) into Jobber — what's being
					pinged or scraped, its health, and what's still on the Phase-4
					roadmap.
				</p>
			</div>

			{isPending && <p className="text-slate-500">Loading…</p>}
			{isError && <p className="text-red-600">Failed to load sources.</p>}

			<div className="space-y-3">
				{data?.map((s) => (
					<SourceCard key={s.key} s={s} />
				))}
			</div>
		</div>
	);
}
