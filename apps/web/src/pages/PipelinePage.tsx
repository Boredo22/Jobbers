import {
	type ApplicationStatus,
	type ApplicationWithEvents,
	ApplicationWithEventsSchema,
	TailoredDraftRecordSchema,
} from "@jobber/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { TailorDialog, type TailorTarget } from "@/components/TailorDialog";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { apiGet, apiSend } from "@/lib/api";
import { toastError } from "@/lib/toast";

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
	// Which posting the tailor dialog is open for (null = closed). Lets you
	// tailor AFTER marking applied — triage is no longer the only entry point.
	const [tailorTarget, setTailorTarget] = useState<TailorTarget | null>(null);
	const [copied, setCopied] = useState(false);

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
		onError: () =>
			toastError("Status change didn't save — still the old status."),
	});

	const byStatus = (status: ApplicationStatus): ApplicationWithEvents[] =>
		data?.filter((a) => a.status === status) ?? [];

	const selected = data?.find((a) => a.id === selectedId) ?? null;

	// The latest saved tailor draft for the selected application's posting.
	// Same query key as TailorDialog uses, so saving a draft there refreshes
	// this section without any manual wiring. Only fetched while the dialog is
	// open on a posting-linked application.
	const draftQ = useQuery({
		queryKey: ["tailor-draft", selected?.jobPostingId],
		queryFn: () =>
			apiGet(
				`/api/postings/${selected?.jobPostingId}/tailor`,
				TailoredDraftRecordSchema.nullable(),
			),
		enabled: selected?.jobPostingId != null,
	});

	// Captured outside the JSX because TS can't carry a `draftQ.data &&` guard
	// into an onClick closure (the property could have changed by call time).
	const savedNote = draftQ.data?.outreachNote ?? null;

	const copyNote = async (note: string) => {
		await navigator.clipboard.writeText(note);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

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
											onClick={() => {
												setSelectedId(app.id);
												setCopied(false);
											}}
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

						{/* Outreach note: the thing you actually need at apply/follow-up
						    time. Only posting-linked applications can have one (manual
						    entries have no posting to tailor against). */}
						{selected.jobPostingId && (
							<div className="mt-4">
								<div className="mb-2 flex items-center justify-between">
									<h4 className="font-medium text-slate-600 text-sm">
										Outreach note
									</h4>
									<Button
										size="sm"
										variant="outline"
										onClick={() =>
											setTailorTarget({
												jobPostingId: selected.jobPostingId as string,
												title: selected.roleTitle,
												companyName: selected.companyName,
											})
										}
									>
										✨ Tailor
									</Button>
								</div>
								{draftQ.isPending && (
									<p className="text-slate-400 text-sm">Loading…</p>
								)}
								{savedNote !== null && (
									<div className="space-y-2">
										<p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-slate-700 text-sm">
											{savedNote}
										</p>
										<Button
											size="sm"
											variant="outline"
											onClick={() => copyNote(savedNote)}
										>
											{copied ? "Copied ✓" : "Copy note"}
										</Button>
									</div>
								)}
								{draftQ.data === null && !draftQ.isPending && (
									<p className="text-slate-400 text-sm">
										No saved draft yet — ✨ Tailor to create one.
									</p>
								)}
							</div>
						)}

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

			{/* Same remount-via-key trick as TriagePage: a different posting gets a
			    fresh dialog with fresh state. */}
			<TailorDialog
				key={tailorTarget?.jobPostingId ?? "none"}
				item={tailorTarget}
				onClose={() => setTailorTarget(null)}
			/>
		</div>
	);
}
