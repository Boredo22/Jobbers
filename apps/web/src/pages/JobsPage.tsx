import {
	type JobListItem,
	JobListItemSchema,
	type JobSource,
} from "@jobber/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { TitleFiltersDialog } from "@/components/TitleFiltersDialog";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";

const JobListSchema = z.array(JobListItemSchema);

// We render at most this many rows — with thousands of open postings, dumping
// them all into the DOM would jank the page. A note shows when we've capped.
const MAX_RENDER = 400;

// How each ingestion source is labelled/coloured in the table. Mirrors the
// JobSource enum, so adding a source in shared surfaces a compile error here
// until it's given a badge — the type keeps the UI honest.
const SOURCE_BADGE: Record<
	JobSource,
	{ label: string; variant: BadgeProps["variant"] }
> = {
	poller: { label: "ATS", variant: "neutral" },
	hn: { label: "HN", variant: "amber" },
	rss: { label: "RSS", variant: "amber" },
	manual: { label: "Manual", variant: "blue" },
};

// "Jul 21" is enough at a glance; add the year only once a posting is stale
// enough to be from a previous one.
function seenDate(d: Date): string {
	const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
	if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}

function comp(job: JobListItem): string {
	if (job.compMin && job.compMax)
		return `$${Math.round(job.compMin / 1000)}k–$${Math.round(job.compMax / 1000)}k`;
	if (job.compMin) return `$${Math.round(job.compMin / 1000)}k+`;
	return "—";
}

export function JobsPage() {
	// Toggle state lives in the component. Both default ON — the useful view is
	// "open roles that passed the prefilter".
	const [openOnly, setOpenOnly] = useState(true);
	const [candidateOnly, setCandidateOnly] = useState(true);
	// The owner is US-based, so hiding known-foreign roles is the useful default.
	const [usOnly, setUsOnly] = useState(true);

	// Build the querystring from the toggles. Filtering happens SERVER-side
	// (7000+ postings shouldn't cross the wire), so the toggles drive the URL.
	const params = new URLSearchParams();
	if (openOnly) params.set("status", "open");
	if (candidateOnly) params.set("candidate", "true");
	if (usOnly) params.set("usOnly", "true");
	const qs = params.toString();

	const { data, isPending, isError } = useQuery({
		// The key INCLUDES the filters: change a toggle → new key → TanStack Query
		// fetches (and caches) that combination separately. Flip back and the
		// previous result is served instantly from cache. This is why the key is
		// an array with the params, not just ["jobs"].
		queryKey: ["jobs", { openOnly, candidateOnly, usOnly }],
		queryFn: () => apiGet(`/api/jobs?${qs}`, JobListSchema),
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h2 className="font-semibold text-2xl">Jobs</h2>
				<div className="flex gap-4 text-sm">
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={openOnly}
							onChange={(e) => setOpenOnly(e.target.checked)}
						/>
						Open only
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={candidateOnly}
							onChange={(e) => setCandidateOnly(e.target.checked)}
						/>
						Candidates only
					</label>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={usOnly}
							onChange={(e) => setUsOnly(e.target.checked)}
						/>
						US only
					</label>
					<TitleFiltersDialog />
				</div>
			</div>

			{isPending && <p className="text-slate-500">Loading…</p>}
			{isError && <p className="text-red-600">Failed to load jobs.</p>}

			{data && (
				<>
					<p className="text-slate-500 text-sm">
						{data.length} posting{data.length === 1 ? "" : "s"}
						{data.length > MAX_RENDER && ` (showing first ${MAX_RENDER})`}
					</p>
					<div className="rounded-lg border border-slate-200 bg-white">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Company</TableHead>
									<TableHead>Source</TableHead>
									<TableHead>Title</TableHead>
									<TableHead>Location</TableHead>
									<TableHead>Comp</TableHead>
									<TableHead>First seen</TableHead>
									<TableHead>Flags</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.slice(0, MAX_RENDER).map((job) => (
									<TableRow key={job.id}>
										<TableCell className="font-medium">
											{job.companyName}
										</TableCell>
										<TableCell>
											<Badge variant={SOURCE_BADGE[job.source].variant}>
												{SOURCE_BADGE[job.source].label}
											</Badge>
										</TableCell>
										<TableCell>
											<a
												href={job.url}
												target="_blank"
												rel="noreferrer"
												className="text-blue-700 hover:underline"
											>
												{job.title}
											</a>
										</TableCell>
										<TableCell className="text-slate-600">
											{job.location ?? "—"}
										</TableCell>
										<TableCell className="text-slate-600">
											{comp(job)}
										</TableCell>
										<TableCell className="whitespace-nowrap text-slate-600">
											{seenDate(job.firstSeenAt)}
										</TableCell>
										<TableCell className="space-x-1">
											{job.remote && <Badge variant="blue">Remote</Badge>}
											{job.candidate && (
												<Badge variant="green">Candidate</Badge>
											)}
											{job.status === "closed" && (
												<Badge variant="outline">Closed</Badge>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				</>
			)}
		</div>
	);
}
