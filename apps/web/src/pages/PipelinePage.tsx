import {
	type ApplicationStatus,
	type ApplicationWithEvents,
	ApplicationWithEventsSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api";

const ApplicationListSchema = z.array(ApplicationWithEventsSchema);

// The pipeline columns, in flow order. Also the option list for the status
// select in the dialog.
const STATUSES: ApplicationStatus[] = [
	"applied",
	"screen",
	"interview",
	"offer",
	"rejected",
	"ghosted",
];

const STATUS_BADGE: Record<ApplicationStatus, BadgeProps["variant"]> = {
	applied: "blue",
	screen: "amber",
	interview: "amber",
	offer: "green",
	rejected: "red",
	ghosted: "neutral",
};

function fmtDate(d: Date): string {
	return new Date(d).toLocaleDateString();
}

export function PipelinePage() {
	const queryClient = useQueryClient();
	// We track only the SELECTED id, not a copy of the application. The card data
	// always comes from the query cache, so after a status change the dialog
	// re-renders with fresh data automatically.
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const { data, isPending, isError } = useQuery({
		queryKey: ["applications"],
		queryFn: () => apiGet("/api/applications", ApplicationListSchema),
	});

	const mutation = useMutation({
		mutationFn: (vars: { id: string; status: ApplicationStatus }) =>
			apiSend(
				`/api/applications/${vars.id}/status`,
				"PATCH",
				{ status: vars.status },
				ApplicationWithEventsSchema,
			),
		// After the server confirms, mark the applications query stale. TanStack
		// Query refetches it and every card + the open dialog re-render with the
		// new status and the freshly-appended event — no manual state juggling,
		// no page reload. THIS is the invalidation pattern worth internalizing.
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["applications"] });
		},
	});

	const byStatus = (status: ApplicationStatus): ApplicationWithEvents[] =>
		data?.filter((a) => a.status === status) ?? [];

	const selected = data?.find((a) => a.id === selectedId) ?? null;

	return (
		<div className="space-y-4">
			<h2 className="font-semibold text-2xl">Pipeline</h2>

			{isPending && <p className="text-slate-500">Loading…</p>}
			{isError && <p className="text-red-600">Failed to load applications.</p>}

			{data && (
				<div className="flex gap-4 overflow-x-auto pb-2">
					{STATUSES.map((status) => {
						const apps = byStatus(status);
						return (
							<div key={status} className="w-64 shrink-0">
								<div className="mb-2 flex items-center gap-2">
									<Badge variant={STATUS_BADGE[status]}>{status}</Badge>
									<span className="text-slate-400 text-xs">{apps.length}</span>
								</div>
								<div className="space-y-2">
									{apps.map((app) => (
										<Card
											key={app.id}
											className="cursor-pointer hover:border-slate-400"
											onClick={() => setSelectedId(app.id)}
										>
											<CardContent className="p-3">
												<p className="font-medium text-sm">{app.companyName}</p>
												<p className="text-slate-500 text-xs">
													{app.roleTitle}
												</p>
												<p className="mt-1 text-slate-400 text-xs">
													applied {fmtDate(app.appliedAt)}
												</p>
											</CardContent>
										</Card>
									))}
									{apps.length === 0 && (
										<p className="px-1 text-slate-300 text-xs">—</p>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* One dialog, driven by selectedId. Open when an application is selected;
			    closing clears the selection. */}
			<Dialog
				open={selected !== null}
				onOpenChange={(open) => !open && setSelectedId(null)}
			>
				{selected && (
					<DialogContent>
						<DialogTitle>{selected.companyName}</DialogTitle>
						<DialogDescription>{selected.roleTitle}</DialogDescription>

						<div className="mt-4">
							<label
								htmlFor="status-select"
								className="mb-1 block font-medium text-slate-600 text-sm"
							>
								Status
							</label>
							<select
								id="status-select"
								className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
								value={selected.status}
								disabled={mutation.isPending}
								onChange={(e) =>
									mutation.mutate({
										id: selected.id,
										status: e.target.value as ApplicationStatus,
									})
								}
							>
								{STATUSES.map((s) => (
									<option key={s} value={s}>
										{s}
									</option>
								))}
							</select>
						</div>

						<div className="mt-4">
							<h4 className="mb-2 font-medium text-slate-600 text-sm">
								Timeline
							</h4>
							<ul className="space-y-1.5">
								{selected.events.map((e) => (
									<li key={e.id} className="flex items-baseline gap-2 text-sm">
										<span className="text-slate-400 text-xs tabular-nums">
											{fmtDate(e.occurredAt)}
										</span>
										<span className="font-medium">{e.type}</span>
										{e.detail && (
											<span className="text-slate-500">— {e.detail}</span>
										)}
									</li>
								))}
							</ul>
						</div>
					</DialogContent>
				)}
			</Dialog>
		</div>
	);
}
